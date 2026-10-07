type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

type JiraLoginForm = {
  action: string;
  fields: Array<{ name: string; value: string }>;
};

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2]);
  }
  return result;
}

function parseLoginForm(html: string, baseUrl: string): JiraLoginForm | null {
  const formMatch = html.match(/<form\b[^>]*>/i);
  if (!formMatch || formMatch.index === undefined) return null;
  const formAttributes = attributes(formMatch[0]);
  const formEnd = html.indexOf("</form>", formMatch.index);
  const formHtml = html.slice(formMatch.index, formEnd >= 0 ? formEnd : html.length);
  const fields: JiraLoginForm["fields"] = [];
  for (const match of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const input = attributes(match[0]);
    const type = (input.type || "text").toLowerCase();
    if (input.name) fields.push({ name: input.name, value: type === "password" ? "" : input.value || "" });
  }
  const action = new URL(formAttributes.action || "", baseUrl).toString();
  return fields.length > 0 && fields.some((field) => field.name === "username") && fields.some((field) => field.name === "password")
    ? { action, fields }
    : null;
}

function setCookieValues(headers: Headers): string[] {
  const withSetCookie = headers as HeadersWithSetCookie;
  if (typeof withSetCookie.getSetCookie === "function") return withSetCookie.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function locationFrom(response: Response, currentUrl: string): string | null {
  const location = response.headers.get("location");
  return location ? new URL(location, currentUrl).toString() : null;
}

export class JiraOidcSession {
  private baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cookies = new Map<string, Map<string, string>>();
  private authenticated = false;
  private loginPromise: Promise<void> | undefined;

  constructor(baseUrl: string, fetchImpl: typeof fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  updateBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.clear();
  }

  hasSession(): boolean {
    return this.authenticated && Boolean(this.cookieHeader(this.baseUrl));
  }

  cookieHeader(url: string): string | null {
    const values = this.cookies.get(new URL(url).host);
    if (!values || values.size === 0) return null;
    return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  clear(): void {
    this.cookies.clear();
    this.authenticated = false;
  }

  async login(username: string, password: string): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    const pending = this.performLogin(username, password);
    this.loginPromise = pending;
    try {
      await pending;
    } finally {
      if (this.loginPromise === pending) this.loginPromise = undefined;
    }
  }

  async loginWithRestSession(username: string, password: string): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    const pending = this.performRestSessionLogin(username, password);
    this.loginPromise = pending;
    try {
      await pending;
    } finally {
      if (this.loginPromise === pending) this.loginPromise = undefined;
    }
  }

  private async performRestSessionLogin(username: string, password: string): Promise<void> {
    this.clear();
    const response = await this.fetchWithCookies(`${this.baseUrl}/rest/auth/1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username, password }),
    });
    await response.arrayBuffer();
    if (!response.ok || !this.cookieHeader(this.baseUrl)) throw new Error("Jira REST 登录未建立会话");
    this.authenticated = true;
  }

  private async performLogin(username: string, password: string): Promise<void> {
    this.clear();
    let currentUrl = `${this.baseUrl}/login.jsp`;
    let response = await this.fetchWithCookies(currentUrl);
    let nextUrl = locationFrom(response, currentUrl);
    await response.arrayBuffer();
    if (!nextUrl) throw new Error("Jira 登录未跳转到 OIDC");

    currentUrl = nextUrl;
    response = await this.fetchWithCookies(currentUrl);
    nextUrl = locationFrom(response, currentUrl);
    await response.arrayBuffer();
    if (!nextUrl) throw new Error("Jira OIDC 未跳转到 SSO");

    currentUrl = nextUrl;
    response = await this.fetchWithCookies(currentUrl);
    const loginHtml = await response.text();
    const form = parseLoginForm(loginHtml, currentUrl);
    if (!form) throw new Error("Jira SSO 登录页未提供用户名密码表单");

    const formData = new URLSearchParams(form.fields.map((field) => [field.name, field.value]));
    formData.set("username", username);
    formData.set("password", password);
    currentUrl = form.action;
    response = await this.fetchWithCookies(currentUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formData,
    });

    let callbackVisited = false;
    for (let redirectCount = 0; redirectCount < 10; redirectCount += 1) {
      callbackVisited ||= new URL(currentUrl).pathname.includes("/plugins/servlet/oidc/auth");
      nextUrl = locationFrom(response, currentUrl);
      await response.arrayBuffer();
      if (!nextUrl || response.status < 300 || response.status >= 400) break;
      currentUrl = nextUrl;
      response = await this.fetchWithCookies(currentUrl);
    }

    if (!callbackVisited || !this.cookieHeader(this.baseUrl)) throw new Error("Jira SSO 登录未建立会话");
    this.authenticated = true;
  }

  private async fetchWithCookies(url: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers ?? {});
    const cookie = this.cookieHeader(url);
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
    const response = await this.fetchImpl(url, { ...options, headers, redirect: "manual" });
    this.rememberCookies(url, response.headers);
    return response;
  }

  private rememberCookies(url: string, headers: Headers): void {
    const host = new URL(url).host;
    const values = this.cookies.get(host) ?? new Map<string, string>();
    for (const rawCookie of setCookieValues(headers)) {
      const pair = rawCookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) values.set(name, value);
      else values.delete(name);
    }
    if (values.size > 0) this.cookies.set(host, values);
  }
}
