const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
const requireAuth = process.argv.includes("--require-auth");
const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const model = process.env.ANTHROPIC_MODEL?.trim() || "connectivity-probe";
const probeTimeoutMs = 90_000;

if (!baseUrl) {
  console.error(JSON.stringify({ reachable: false, error: "ANTHROPIC_BASE_URL 未配置" }));
  process.exit(2);
}
if (requireAuth && !authToken && !apiKey) {
  console.error(JSON.stringify({ reachable: false, authenticated: false, error: "模型认证凭据未配置" }));
  process.exit(2);
}

const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
const startedAt = Date.now();

try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal: AbortSignal.timeout(probeTimeoutMs),
  });
  const body = (await response.text()).replace(/\s+/g, " ").slice(0, 160);
  const result = {
    reachable: true,
    authenticated: Boolean(authToken || apiKey),
    status: response.status,
    latencyMs: Date.now() - startedAt,
    bodyPreview: body || null,
  };
  console.log(JSON.stringify(result));
  if (requireAuth && !response.ok) process.exitCode = 1;
} catch (error) {
  const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
  const causeRecord = cause && typeof cause === "object" ? cause : undefined;
  console.error(JSON.stringify({
    reachable: false,
    latencyMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error),
    causeCode: typeof causeRecord?.code === "string" ? causeRecord.code : undefined,
    causeMessage: cause instanceof Error ? cause.message : undefined,
  }));
  process.exitCode = 1;
}
