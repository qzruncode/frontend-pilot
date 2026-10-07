import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

const NORMALIZE_SYSTEM_MESSAGES_ENV = "CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function textSystemBlocks(content: unknown): JsonRecord[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .map(asRecord)
    .filter((block): block is JsonRecord => block?.type === "text" && typeof block.text === "string");
}

function existingSystemBlocks(value: unknown): JsonRecord[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((block): block is JsonRecord => block !== null);
}

/**
 * Anthropic's wire format carries system content in the top-level `system`
 * field. Some compatible gateways reject the Claude Code SDK's dynamic
 * `role: "system"` message when it appears after tool results. Keep the
 * message content but keep it in the same user turn as the preceding tool
 * result. This preserves the dynamic message's position without relying on a
 * gateway to accept a second `system` role in the message history.
 */
export function normalizeClaudeGatewayMessages(value: unknown): { value: unknown; movedCount: number } {
  const payload = asRecord(value);
  const messages = Array.isArray(payload?.messages) ? payload.messages : null;
  if (!payload || !messages) return { value, movedCount: 0 };

  const systemMessages = messages.filter((message) => asRecord(message)?.role === "system");
  if (systemMessages.length === 0) return { value, movedCount: 0 };

  const movedBlocks = systemMessages.flatMap((message) => textSystemBlocks(asRecord(message)?.content));
  if (movedBlocks.length === 0) return { value, movedCount: 0 };

  const normalizedMessages = messages.filter((message) => asRecord(message)?.role !== "system");
  let lastUserIndex = -1;
  for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
    if (asRecord(normalizedMessages[index])?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) {
    return {
      value: {
        ...payload,
        system: [...existingSystemBlocks(payload.system), ...movedBlocks],
        messages: normalizedMessages,
      },
      movedCount: systemMessages.length,
    };
  }

  const lastUser = asRecord(normalizedMessages[lastUserIndex]);
  if (!lastUser) return { value, movedCount: 0 };
  const userContent = Array.isArray(lastUser.content)
    ? lastUser.content
    : [{ type: "text", text: typeof lastUser.content === "string" ? lastUser.content : "" }];
  normalizedMessages[lastUserIndex] = { ...lastUser, content: [...userContent, ...movedBlocks] };
  return { value: { ...payload, messages: normalizedMessages }, movedCount: systemMessages.length };
}

function compatibilityEnabled(environment: Record<string, string | undefined>): boolean {
  const value = environment[NORMALIZE_SYSTEM_MESSAGES_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

function requestHeaders(request: IncomingMessage, body: Buffer): Record<string, string> {
  const headers: Record<string, string> = { "content-length": String(body.length) };
  for (const [key, value] of Object.entries(request.headers)) {
    if (key === "host" || key === "connection" || key === "content-length" || key === "transfer-encoding") continue;
    if (typeof value === "string") headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(", ");
  }
  return headers;
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

type ForwardRequestCancellation = () => void;

function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  body: Buffer,
  activeRequests: Set<ForwardRequestCancellation>,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let upstream: ClientRequest | undefined;
    let upstreamResponse: IncomingMessage | undefined;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      activeRequests.delete(cancel);
      resolve();
      return true;
    };
    const cancel: ForwardRequestCancellation = () => {
      if (!settle()) return;
      upstreamResponse?.destroy();
      upstream?.destroy();
      if (!response.destroyed) response.destroy();
    };
    const fail = (error: unknown): void => {
      if (!settle()) return;
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      } else if (!response.destroyed) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    };

    activeRequests.add(cancel);
    const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    upstream = requestFn(target, { method: request.method, headers: requestHeaders(request, body) }, (receivedResponse) => {
      upstreamResponse = receivedResponse;
      const headers = { ...receivedResponse.headers };
      delete headers["content-length"];
      delete headers.connection;
      response.writeHead(receivedResponse.statusCode ?? 502, headers);
      receivedResponse.on("end", settle);
      receivedResponse.on("aborted", () => fail(new Error("上游响应被中止")));
      receivedResponse.on("close", () => fail(new Error("上游响应在结束前关闭")));
      receivedResponse.on("error", fail);
      receivedResponse.pipe(response);
    });
    upstream.on("error", fail);
    request.on("aborted", cancel);
    response.on("close", cancel);
    response.on("error", cancel);
    upstream.end(body);
  });
}

export interface ClaudeGatewayCompatibilityHandle {
  environment: Record<string, string | undefined>;
  close: () => Promise<void>;
}

/**
 * Start an ephemeral loopback proxy only for gateways that need Anthropic
 * message-shape normalization. The SDK keeps talking to a normal
 * `ANTHROPIC_BASE_URL`; the proxy forwards all other requests unchanged.
 */
export async function prepareClaudeGatewayCompatibility(
  environment: Record<string, string | undefined>,
): Promise<ClaudeGatewayCompatibilityHandle> {
  if (!compatibilityEnabled(environment)) {
    return { environment, close: async () => undefined };
  }

  const configuredBaseUrl = environment.ANTHROPIC_BASE_URL?.trim();
  if (!configuredBaseUrl) throw new Error(`${NORMALIZE_SYSTEM_MESSAGES_ENV} 需要同时配置 ANTHROPIC_BASE_URL`);
  const baseUrl = new URL(configuredBaseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error(`${NORMALIZE_SYSTEM_MESSAGES_ENV} 只支持 HTTP(S) 的 ANTHROPIC_BASE_URL`);
  }

  const activeRequests = new Set<ForwardRequestCancellation>();
  let closed = false;
  const server = createServer(async (request, response) => {
    try {
      const body = await requestBody(request);
      let outboundBody = body;
      const contentType = request.headers["content-type"];
      if (body.length > 0 && typeof contentType === "string" && contentType.includes("application/json")) {
        try {
          const parsed = JSON.parse(body.toString("utf8")) as unknown;
          const normalized = normalizeClaudeGatewayMessages(parsed);
          if (normalized.movedCount > 0) outboundBody = Buffer.from(JSON.stringify(normalized.value));
        } catch {
          // Non-JSON or malformed requests should be forwarded for the
          // upstream service to report normally.
        }
      }
      if (closed) {
        response.destroy();
        return;
      }
      const target = new URL(request.url ?? "/", baseUrl.origin);
      await forwardRequest(request, response, target, outboundBody, activeRequests);
    } catch (error) {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("无法启动 Claude 网关兼容层");
  }
  const proxyBaseUrl = `http://127.0.0.1:${(address as AddressInfo).port}${baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`}`;
  return {
    environment: { ...environment, ANTHROPIC_BASE_URL: proxyBaseUrl },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const cancel of activeRequests) cancel();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
