const pollIntervalMs = 5_000;
const heartbeatIntervalMs = 30_000;
const maxConsecutivePollRetries = 10;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 CI 变量 ${name}`);
  return value;
}

function reviewServiceUrl() {
  const value = required("FRONTEND_PILOT_REVIEW_URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("FRONTEND_PILOT_REVIEW_URL 必须是没有用户名和密码的 HTTP(S) 地址");
  }
  return value.replace(/\/+$/, "");
}

function responseBody(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { error: text || "empty_response" };
  }
}

async function requestJson(url, token, path, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "job-token": token,
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = responseBody(await response.text());
  return { response, body };
}

function progressMessage(job) {
  const events = Array.isArray(job.progress) ? job.progress : [];
  const latest = events.at(-1);
  return latest?.detail ? `${latest.message}：${latest.detail}` : (latest?.message ?? job.status);
}

function printReviewFailure(job) {
  const result = job.result;
  const blocking = result?.blockingFindingCount ?? 0;
  const severities = Array.isArray(result?.blockingSeverities) ? result.blockingSeverities.join("/") : "";
  process.stderr.write(`Frontend Pilot 审核阻断：${blocking} 个问题${severities ? `（${severities}）` : ""}\n`);
  if (job.error) process.stderr.write(`${job.error}\n`);
}

function errorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!cause || typeof cause !== "object") return error.message;
  const details = [
    typeof cause.code === "string" ? cause.code : null,
    typeof cause.address === "string" ? cause.address : null,
    typeof cause.port === "number" ? String(cause.port) : null,
    typeof cause.message === "string" ? cause.message : null,
  ].filter(Boolean);
  return details.length > 0 ? `${error.message} (${details.join(", ")})` : error.message;
}

const retryablePollErrorCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_BODY_TIMEOUT",
]);

function isRetryablePollError(error) {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    if (!(current instanceof Error)) {
      current = current.cause;
      continue;
    }
    if (current.name === "AbortError" || current.name === "TimeoutError") return true;
    if (typeof current.code === "string" && retryablePollErrorCodes.has(current.code)) return true;
    if (
      typeof current.message === "string" &&
      /^the operation was aborted due to timeout$/i.test(current.message.trim())
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function isRetryablePollStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function pollReviewJob(serviceUrl, token, jobId, retryState) {
  while (true) {
    let polled;
    try {
      polled = await requestJson(
        serviceUrl,
        token,
        `/api/v1/ci/reviews/${encodeURIComponent(jobId)}`,
      );
    } catch (error) {
      if (!isRetryablePollError(error)) throw error;
      await waitForPollRetry(retryState, error);
      continue;
    }

    if (polled.response.ok && polled.body?.id) {
      retryState.consecutiveFailures = 0;
      return polled.body;
    }

    const error = new Error(`查询 Frontend Pilot 审核失败（HTTP ${polled.response.status}）`);
    if (!isRetryablePollStatus(polled.response.status)) throw error;
    await waitForPollRetry(retryState, error);
  }
}

async function waitForPollRetry(retryState, error) {
  if (retryState.consecutiveFailures >= maxConsecutivePollRetries) {
    throw new Error(
      `Frontend Pilot 状态查询连续失败 ${maxConsecutivePollRetries} 次，停止重试`,
      { cause: error },
    );
  }
  const consecutiveFailures = retryState.consecutiveFailures;
  const exponent = Math.min(consecutiveFailures, 5);
  const delayMs = Math.min(1_000 * 2 ** exponent, 30_000);
  process.stderr.write(
    `Frontend Pilot 状态查询暂时失败（${errorMessage(error)}），${delayMs / 1_000} 秒后继续查询（连续第 ${consecutiveFailures + 1} 次失败）。\n`,
  );
  retryState.consecutiveFailures += 1;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function main() {
  const serviceUrl = reviewServiceUrl();
  const token = required("CI_JOB_TOKEN");
  const payload = {
    projectId: required("CI_PROJECT_ID"),
    projectPath: process.env.CI_PROJECT_PATH?.trim() || undefined,
    mrIid: required("CI_MERGE_REQUEST_IID"),
    headSha: required("CI_COMMIT_SHA"),
    targetBranch: process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME?.trim() || undefined,
    pipelineId: required("CI_PIPELINE_ID"),
    jobId: required("CI_JOB_ID"),
    jobUrl: required("CI_JOB_URL"),
  };

  const created = await requestJson(serviceUrl, token, "/api/v1/ci/reviews", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (created.response.status === 409 && created.body?.error === "review_head_is_stale") {
    process.stdout.write("当前 CI Job 对应的提交已被新提交替代，跳过旧审核。\n");
    return;
  }
  if (!created.response.ok || !created.body?.job?.id) {
    throw new Error(`提交 Frontend Pilot 审核失败（HTTP ${created.response.status}）`);
  }

  let job = created.body.job;
  const pollRetryState = { consecutiveFailures: 0 };
  let lastProgress = "";
  let lastOutputAt = Date.now();
  while (true) {
    const message = progressMessage(job);
    const now = Date.now();
    if (message !== lastProgress) {
      process.stdout.write(`Frontend Pilot：${message}\n`);
      lastProgress = message;
      lastOutputAt = now;
    } else if ((job.status === "queued" || job.status === "running") && now - lastOutputAt >= heartbeatIntervalMs) {
      process.stdout.write(`Frontend Pilot：审核仍在执行（${job.status}）\n`);
      lastOutputAt = now;
    }

    if (job.status === "completed") {
      if (job.result?.gate === "passed") {
        process.stdout.write("Frontend Pilot 审核通过。\n");
        return;
      }
      printReviewFailure(job);
      process.exitCode = 1;
      return;
    }
    if (job.status === "superseded") {
      process.stdout.write("本次审核已被新提交替代，由最新 CI Job 接管。\n");
      return;
    }
    if (job.status === "failed" || job.status === "canceled") {
      printReviewFailure(job);
      process.exitCode = 1;
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    job = await pollReviewJob(serviceUrl, token, job.id, pollRetryState);
  }
}

main().catch((error) => {
  process.stderr.write(`Frontend Pilot CI 审核失败：${errorMessage(error)}\n`);
  process.exitCode = 1;
});
