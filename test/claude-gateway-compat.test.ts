import { createServer, request as httpRequest, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { normalizeClaudeGatewayMessages, prepareClaudeGatewayCompatibility } from "../src/claude-gateway-compat.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function expectSettled<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("Claude gateway compatibility", () => {
  it("keeps dynamic system messages in the preceding user turn", () => {
    const normalized = normalizeClaudeGatewayMessages({
      system: [{ type: "text", text: "静态系统提示" }],
      messages: [
        { role: "user", content: "检查文件" },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "文件内容" }] },
        { role: "system", content: [{ type: "text", text: "动态系统提醒" }] },
      ],
    });

    expect(normalized.movedCount).toBe(1);
    expect(normalized.value).toEqual({
      system: [{ type: "text", text: "静态系统提示" }],
      messages: [
        { role: "user", content: "检查文件" },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "文件内容" },
          { type: "text", text: "动态系统提醒" },
        ] },
      ],
    });
  });

  it("passes through payloads without system messages", () => {
    const payload = { messages: [{ role: "user", content: "检查文件" }] };
    expect(normalizeClaudeGatewayMessages(payload)).toEqual({ value: payload, movedCount: 0 });
  });

  it("closes an in-flight upstream stream when the compatibility handle closes", async () => {
    let upstreamResponseClosed = false;
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: open\n\n");
      response.on("close", () => { upstreamResponseClosed = true; });
    });
    const upstreamPort = await listen(upstream);
    const handle = await prepareClaudeGatewayCompatibility({
      CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES: "true",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    let client: ClientRequest | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        client = httpRequest(handle.environment.ANTHROPIC_BASE_URL!, {
          method: "POST",
          headers: { "content-type": "application/json" },
        }, (response) => {
          response.once("data", () => resolve());
          response.on("error", () => undefined);
        });
        client.on("error", () => undefined);
        client.once("close", () => {
          if (!client?.destroyed) reject(new Error("proxy client closed before receiving data"));
        });
        client.end("{}");
      });

      await expectSettled(handle.close());
      await expectSettled(new Promise<void>((resolve) => {
        const check = (): void => {
          if (upstreamResponseClosed) resolve();
          else setTimeout(check, 5);
        };
        check();
      }));
      expect(upstreamResponseClosed).toBe(true);
    } finally {
      client?.destroy();
      await handle.close();
      await closeServer(upstream);
    }
  });

  it("handles a premature upstream response close without leaving the proxy open", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: partial\n\n");
      setTimeout(() => response.socket?.destroy(), 10);
    });
    const upstreamPort = await listen(upstream);
    const handle = await prepareClaudeGatewayCompatibility({
      CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES: "true",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    try {
      await expectSettled(new Promise<void>((resolve, reject) => {
        const client = httpRequest(handle.environment.ANTHROPIC_BASE_URL!, {
          method: "POST",
          headers: { "content-type": "application/json" },
        }, (response) => {
          response.once("aborted", resolve);
          response.once("error", resolve);
          response.once("end", () => reject(new Error("upstream response unexpectedly completed")));
        });
        client.on("error", resolve);
        client.end("{}");
      }));
      await expectSettled(handle.close());
    } finally {
      await handle.close();
      await closeServer(upstream);
    }
  });
});
