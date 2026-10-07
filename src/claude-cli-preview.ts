import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const PREVIEW_TOKEN_QUERY = "preview_token";
const PREVIEW_COOKIE = "frontend_pilot_preview";
const PREVIEW_ENDPOINT_PATTERN = /(?:(https?):\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?=\/|[\s)\]}>,]|$)/giu;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ClaudeCliPreviewEndpoint {
  port: number;
  proxyPort: number;
  token: string;
  protocol: ClaudeCliPreviewProtocol;
}

export interface ClaudeCliPreviewProxy extends ClaudeCliPreviewEndpoint {
  close: () => Promise<void>;
}

export type ClaudeCliPreviewProtocol = "http" | "https";

export interface ClaudeCliPreviewTarget {
  port: number;
  protocol: ClaudeCliPreviewProtocol;
}

export function createClaudeCliPreviewUrl(host: string, endpoint: ClaudeCliPreviewEndpoint): string {
  const url = new URL(`http://${host}`);
  // The browser-facing listener is created with node:http. The upstream Vite
  // server may use HTTPS, but that protocol is terminated by this proxy and
  // must not be used for the public preview URL.
  if (localHostname(url.hostname)) url.hostname = "localhost";
  url.port = String(endpoint.proxyPort);
  url.pathname = "/";
  url.search = "";
  url.searchParams.set(PREVIEW_TOKEN_QUERY, endpoint.token);
  return url.toString();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function extractClaudeCliPreviewPorts(output: string): number[] {
  return extractClaudeCliPreviewTargets(output).map(({ port }) => port);
}

export function extractClaudeCliPreviewTargets(output: string): ClaudeCliPreviewTarget[] {
  const targets = new Map<number, ClaudeCliPreviewProtocol>();
  PREVIEW_ENDPOINT_PATTERN.lastIndex = 0;
  for (const match of stripAnsi(output).matchAll(PREVIEW_ENDPOINT_PATTERN)) {
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
    const protocol: ClaudeCliPreviewProtocol = match[1]?.toLowerCase() === "https" ? "https" : "http";
    if (targets.get(port) !== "https" || protocol === "https") targets.set(port, protocol);
  }
  return [...targets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([port, protocol]) => ({ port, protocol }));
}

export async function isClaudeCliPreviewTargetAvailable(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function cookieValue(request: IncomingMessage): string | null {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === PREVIEW_COOKIE) return value.join("=") || null;
  }
  return null;
}

function removePreviewTokenFromUrl(rawUrl: string): string {
  const queryStart = rawUrl.indexOf("?");
  if (queryStart < 0) return rawUrl;
  const hashStart = rawUrl.indexOf("#", queryStart);
  const queryEnd = hashStart < 0 ? rawUrl.length : hashStart;
  const rawQuery = rawUrl.slice(queryStart + 1, queryEnd);
  const remainingQuery = rawQuery.split("&").filter((part) => {
    const separator = part.indexOf("=");
    const rawName = separator < 0 ? part : part.slice(0, separator);
    try {
      return decodeURIComponent(rawName.replace(/\+/gu, " ")) !== PREVIEW_TOKEN_QUERY;
    } catch {
      return true;
    }
  });
  const query = remainingQuery.length > 0 ? `?${remainingQuery.join("&")}` : "";
  return `${rawUrl.slice(0, queryStart)}${query}${hashStart < 0 ? "" : rawUrl.slice(hashStart)}`;
}

function previewRequest(request: IncomingMessage, token: string): { authorized: boolean; setCookie: boolean; path: string } {
  const rawUrl = request.url ?? "/";
  const url = new URL(rawUrl, "http://preview.local");
  const queryToken = url.searchParams.get(PREVIEW_TOKEN_QUERY);
  const authorizedByQuery = queryToken === token;
  const authorizedByCookie = cookieValue(request) === token;
  return {
    authorized: authorizedByQuery || authorizedByCookie,
    setCookie: authorizedByQuery && !authorizedByCookie,
    path: removePreviewTokenFromUrl(rawUrl),
  };
}

function writeUnauthorized(response: ServerResponse): void {
  response.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end("预览链接无效或已过期");
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(",", 1)[0]?.trim() || null;
}

function previewOrigin(request: IncomingMessage): URL {
  const protocolHeader = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const protocol = protocolHeader === "https" ? "https" : "http";
  const host = firstHeaderValue(request.headers["x-forwarded-host"]) || firstHeaderValue(request.headers.host) || "localhost";
  return new URL(`${protocol}://${host}`);
}

function localHostname(hostname: string): boolean {
  return new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]).has(hostname.toLowerCase());
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function isTargetUrl(url: URL, targetPort: number): boolean {
  return localHostname(url.hostname) && effectivePort(url) === targetPort;
}

function rewriteLocation(location: string, request: IncomingMessage, targetPort: number): string {
  const isAbsolute = /^[a-z][a-z\d+.-]*:/iu.test(location) || location.startsWith("//");
  if (!isAbsolute) return location;
  try {
    const targetUrl = new URL(location, `http://127.0.0.1:${targetPort}`);
    if (!isTargetUrl(targetUrl, targetPort)) return location;
    const rewritten = previewOrigin(request);
    rewritten.pathname = targetUrl.pathname;
    rewritten.search = targetUrl.search;
    rewritten.hash = targetUrl.hash;
    return rewritten.toString();
  } catch {
    return location;
  }
}

function rewriteSetCookie(cookie: string, browserIsSecure: boolean): string {
  let sameSiteNone = false;
  const attributes = cookie.split(";").filter((attribute, index) => {
    if (index === 0) return true;
    const normalized = attribute.trim();
    if (/^domain=/iu.test(normalized)) return false;
    if (!browserIsSecure && /^secure$/iu.test(normalized)) return false;
    if (!browserIsSecure && /^samesite=none$/iu.test(normalized)) {
      sameSiteNone = true;
      return false;
    }
    return true;
  });
  if (sameSiteNone) attributes.push(" SameSite=Lax");
  return attributes.join(";");
}

function rewriteResponseHeaders(headers: Record<string, string | string[] | undefined>, request: IncomingMessage, targetPort: number, setPreviewCookie: boolean, token: string): void {
  const location = headers.location;
  if (typeof location === "string") headers.location = rewriteLocation(location, request, targetPort);
  const cookies = headers["set-cookie"];
  if (cookies) {
    const browserIsSecure = previewOrigin(request).protocol === "https:";
    const values = Array.isArray(cookies) ? cookies : [cookies];
    headers["set-cookie"] = values.map((cookie) => rewriteSetCookie(cookie, browserIsSecure));
  }
  if (setPreviewCookie) {
    const existing = headers["set-cookie"];
    const values = Array.isArray(existing) ? existing : existing ? [existing] : [];
    headers["set-cookie"] = [...values, `${PREVIEW_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`];
  }
}

function proxyHeaders(request: IncomingMessage, targetPort: number): Record<string, string | string[] | undefined> {
  const headers = { ...request.headers };
  delete headers.connection;
  delete headers["proxy-connection"];
  headers.host = `localhost:${targetPort}`;
  return headers;
}

function proxyWebSocketHeaders(request: IncomingMessage, targetPort: number): Record<string, string | string[] | undefined> {
  const headers = proxyHeaders(request, targetPort);
  delete headers.upgrade;
  delete headers["sec-websocket-key"];
  delete headers["sec-websocket-version"];
  delete headers["sec-websocket-extensions"];
  delete headers["sec-websocket-protocol"];
  return headers;
}

function requestedWebSocketProtocol(request: IncomingMessage): string | undefined {
  return firstHeaderValue(request.headers["sec-websocket-protocol"])?.split(",", 1)[0]?.trim() || undefined;
}

function forwardedResponseHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[] | undefined> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())));
}

function forwardHttpRequest(request: IncomingMessage, response: ServerResponse, targetPort: number, targetProtocol: ClaudeCliPreviewProtocol, path: string, setCookie: boolean, token: string): void {
  const requestOptions = {
    hostname: "127.0.0.1",
    port: targetPort,
    method: request.method,
    path,
    headers: proxyHeaders(request, targetPort),
  };
  const onResponse = (upstreamResponse: IncomingMessage) => {
    const headers = forwardedResponseHeaders(upstreamResponse.headers);
    rewriteResponseHeaders(headers, request, targetPort, setCookie, token);
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
  };
  const upstream = targetProtocol === "https"
    ? httpsRequest({ ...requestOptions, rejectUnauthorized: false }, onResponse)
    : httpRequest(requestOptions, onResponse);
  upstream.on("error", (error: unknown) => {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(`预览服务暂不可用：${error instanceof Error ? error.message : String(error)}`);
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function forwardWebSocket(socket: WebSocket, upstream: WebSocket): void {
  const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];
  socket.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) pendingMessages.push({ data, isBinary });
  });
  upstream.on("open", () => {
    for (const message of pendingMessages) upstream.send(message.data, { binary: message.isBinary });
    pendingMessages.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
  });
  const closeBoth = () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  };
  socket.on("close", () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  });
  upstream.on("close", () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  });
  socket.on("error", closeBoth);
  upstream.on("error", closeBoth);
}

export async function createClaudeCliPreviewProxy(targetPort: number, listenHost = "127.0.0.1", targetProtocol: ClaudeCliPreviewProtocol = "http"): Promise<ClaudeCliPreviewProxy> {
  const token = randomBytes(24).toString("base64url");
  const websocketServer = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    const preview = previewRequest(request, token);
    if (!preview.authorized) {
      writeUnauthorized(response);
      return;
    }
    forwardHttpRequest(request, response, targetPort, targetProtocol, preview.path, preview.setCookie, token);
  });

  server.on("upgrade", (request, socket: Socket, head) => {
    const preview = previewRequest(request, token);
    if (!preview.authorized) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      let upstream: WebSocket;
      try {
        const upstreamUrl = `${targetProtocol === "https" ? "wss" : "ws"}://localhost:${targetPort}${preview.path}`;
        const options = {
          headers: proxyWebSocketHeaders(request, targetPort),
          ...(targetProtocol === "https" ? { rejectUnauthorized: false } : {}),
        };
        const protocol = requestedWebSocketProtocol(request);
        upstream = protocol ? new WebSocket(upstreamUrl, protocol, options) : new WebSocket(upstreamUrl, options);
      } catch {
        client.close(1011, "预览服务暂不可用");
        return;
      }
      forwardWebSocket(client, upstream);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, listenHost);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("无法启动 Claude CLI 预览代理");
  }

  let closed = false;
  return {
    port: targetPort,
    proxyPort: (address as AddressInfo).port,
    token,
    protocol: targetProtocol,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
