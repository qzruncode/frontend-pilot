import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createClaudeCliPreviewProxy, createClaudeCliPreviewUrl, extractClaudeCliPreviewPorts, extractClaudeCliPreviewTargets, isClaudeCliPreviewTargetAvailable, type ClaudeCliPreviewProxy } from "../src/claude-cli-preview.js";

const openServers: Server[] = [];
const openWebSocketServers: WebSocketServer[] = [];
const openProxies: ClaudeCliPreviewProxy[] = [];

async function listen(server: Server): Promise<number> {
  openServers.push(server);
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
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试 HTTP 服务没有监听端口");
  return (address as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(openProxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(openWebSocketServers.splice(0).map((server) => closeWebSocketServer(server)));
  await Promise.all(openServers.splice(0).map((server) => closeServer(server)));
});

describe("Claude CLI preview proxy", () => {
  it("extracts unique local development ports from terminal output", () => {
    expect(extractClaudeCliPreviewPorts("\u001b[32mLocal:   http://localhost:5173/\u001b[0m\nNetwork: http://127.0.0.1:4173/\nhttp://localhost:5173/"))
      .toEqual([4173, 5173]);
    expect(extractClaudeCliPreviewPorts("https://example.com:443/  http://0.0.0.0:65536/  http://[::1]:3000/"))
      .toEqual([3000]);
    expect(extractClaudeCliPreviewTargets("Local: https://localhost:3000/\nNetwork: https://127.0.0.1:3000/"))
      .toEqual([{ port: 3000, protocol: "https" }]);
  });

  it("uses HTTP for the public preview URL even when Vite uses HTTPS upstream", () => {
    const url = new URL(createClaudeCliPreviewUrl("192.0.2.10", {
      port: 3000,
      proxyPort: 43673,
      token: "preview-token",
      protocol: "https",
    }));

    expect(url.protocol).toBe("http:");
    expect(url.host).toBe("192.0.2.10:43673");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("preview_token")).toBe("preview-token");
  });

  it("detects when a preview target has stopped listening", async () => {
    const targetServer = createServer();
    const targetPort = await listen(targetServer);

    await expect(isClaudeCliPreviewTargetAvailable(targetPort)).resolves.toBe(true);
    await closeServer(targetServer);
    await expect(isClaudeCliPreviewTargetAvailable(targetPort)).resolves.toBe(false);
  });

  it("protects HTTP and WebSocket preview traffic with a session token", async () => {
    const targetWebSocketServer = new WebSocketServer({ noServer: true });
    openWebSocketServers.push(targetWebSocketServer);
    targetWebSocketServer.on("connection", (socket) => {
      socket.on("message", (message) => socket.send(message));
    });
    const targetServer = createServer((request, response) => {
      if (request.url === "/hello?x=1") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("preview works");
        return;
      }
      response.writeHead(404);
      response.end();
    });
    targetServer.on("upgrade", (request, socket, head) => {
      targetWebSocketServer.handleUpgrade(request, socket, head, (client) => targetWebSocketServer.emit("connection", client, request));
    });
    const targetPort = await listen(targetServer);
    const proxy = await createClaudeCliPreviewProxy(targetPort);
    openProxies.push(proxy);
    const httpBase = `http://127.0.0.1:${proxy.proxyPort}`;

    await expect(fetch(`${httpBase}/hello`)).resolves.toMatchObject({ status: 401 });

    const authorizedResponse = await fetch(`${httpBase}/hello?x=1&preview_token=${encodeURIComponent(proxy.token)}`);
    expect(authorizedResponse.status).toBe(200);
    expect(await authorizedResponse.text()).toBe("preview works");
    expect(authorizedResponse.headers.get("set-cookie")).toContain(`frontend_pilot_preview=${proxy.token}`);

    const cookieResponse = await fetch(`${httpBase}/hello?x=1`, {
      headers: { cookie: `frontend_pilot_preview=${proxy.token}` },
    });
    expect(cookieResponse.status).toBe(200);

    const echoedMessage = await new Promise<{ message: string; protocol: string }>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${proxy.proxyPort}/socket?preview_token=${encodeURIComponent(proxy.token)}`, "vite-hmr");
      client.once("open", () => client.send("hmr-ping"));
      client.once("message", (message) => {
        resolve({ message: message.toString(), protocol: client.protocol });
        client.close();
      });
      client.once("error", reject);
    });
    expect(echoedMessage).toEqual({ message: "hmr-ping", protocol: "vite-hmr" });
  });

  it("preserves the local project host when forwarding requests", async () => {
    let receivedHost: string | undefined;
    const targetServer = createServer((request, response) => {
      receivedHost = request.headers.host;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
    });
    const targetPort = await listen(targetServer);
    const proxy = await createClaudeCliPreviewProxy(targetPort);
    openProxies.push(proxy);

    const response = await fetch(`http://127.0.0.1:${proxy.proxyPort}/?preview_token=${encodeURIComponent(proxy.token)}`);
    expect(response.status).toBe(200);
    expect(receivedHost).toBe(`localhost:${targetPort}`);
  });

  it("preserves valueless query parameters while removing the preview token", async () => {
    let receivedUrl: string | undefined;
    const targetServer = createServer((request, response) => {
      receivedUrl = request.url;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
    });
    const targetPort = await listen(targetServer);
    const proxy = await createClaudeCliPreviewProxy(targetPort);
    openProxies.push(proxy);

    const response = await fetch(`http://127.0.0.1:${proxy.proxyPort}/module.svg?import&react&preview_token=${encodeURIComponent(proxy.token)}`);
    expect(response.status).toBe(200);
    expect(receivedUrl).toBe("/module.svg?import&react");
  });

  it("keeps upstream redirects and cookies on the browser-facing preview origin", async () => {
    let targetPort = 0;
    const targetServer = createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, {
          location: `http://localhost:${targetPort}/saas/login`,
          "set-cookie": ["session=abc; Domain=localhost; Path=/; Secure; SameSite=None"],
        });
        response.end();
        return;
      }
      if (request.url === "/saas/login" && request.headers.cookie?.includes("session=abc")) {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("login page");
        return;
      }
      response.writeHead(404);
      response.end();
    });
    targetPort = await listen(targetServer);
    const proxy = await createClaudeCliPreviewProxy(targetPort);
    openProxies.push(proxy);
    const httpBase = `http://127.0.0.1:${proxy.proxyPort}`;

    const redirected = await fetch(`${httpBase}/start?preview_token=${encodeURIComponent(proxy.token)}`, { redirect: "manual" });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe(`${httpBase}/saas/login`);
    const setCookie = redirected.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("session=abc");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toMatch(/Domain=/iu);
    expect(setCookie).not.toMatch(/; Secure(?:;|$)/iu);

    const cookieHeader = setCookie.split(/,(?=\s*[^;,=]+=[^;,]+)/u).map((cookie) => cookie.split(";", 1)[0]).join("; ");
    const loginPage = await fetch(`${httpBase}/saas/login`, { headers: { cookie: cookieHeader } });
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toBe("login page");
  });
});
