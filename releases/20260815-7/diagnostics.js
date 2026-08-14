import {
  NtfyClient,
  createNtfyGetPublishUrl,
  normalizeServerUrl,
} from "./ntfy.js";

export const DIAGNOSTIC_TIMEOUT_MS = 8_000;

export function createNtfyHealthUrl(serverUrl) {
  return new URL("v1/health", `${normalizeServerUrl(serverUrl)}/`).href;
}

export async function runCommunicationDiagnostics({
  release,
  sameOriginUrl,
  serverUrl,
  scope = globalThis,
  navigatorRef = globalThis.navigator,
  locationRef = globalThis.location,
  matchMediaImpl = globalThis.matchMedia?.bind(globalThis),
  timeoutMs = DIAGNOSTIC_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  const standalone = Boolean(
    navigatorRef?.standalone === true ||
      (typeof matchMediaImpl === "function" && matchMediaImpl("(display-mode: standalone)").matches),
  );
  const report = {
    release: String(release || "unknown"),
    displayMode: standalone ? "standalone" : "browser",
    standalone,
    online: navigatorRef?.onLine !== false,
    origin: safeOrigin(locationRef?.origin),
    serviceWorkerControlled: Boolean(navigatorRef?.serviceWorker?.controller),
    tests: [],
  };

  const cacheBustedSameOriginUrl = new URL(sameOriginUrl);
  cacheBustedSameOriginUrl.searchParams.set("__cp_diag", String(now()));
  report.tests.push(await runFetchProbe({
    id: "01",
    key: "sameOriginFetch",
    label: "同一オリジンfetch",
    url: cacheBustedSameOriginUrl.href,
    init: { method: "GET", mode: "same-origin", cache: "reload" },
    invoke: (url, init) => scope.fetch(url, init),
    timeoutMs,
  }));

  const healthUrl = createNtfyHealthUrl(serverUrl);
  const healthInit = { method: "GET", mode: "cors" };
  const extractedFetch = scope.fetch;
  const clientStyle = typeof extractedFetch === "function"
    ? new NtfyClient({ fetchImpl: extractedFetch, timeoutMs, diagnosticLogger: () => {} })
    : { fetchImpl: extractedFetch };
  const healthProbes = [
    {
      id: "02",
      key: "ntfyGlobalFetch",
      label: "ntfy health / globalThis.fetch",
      invoke: (url, init) => scope.fetch(url, init),
    },
    {
      id: "03",
      key: "ntfyBoundFetch",
      label: "ntfy health / fetch.call(globalThis)",
      invoke: (url, init) => scope.fetch.call(scope, url, init),
    },
    {
      id: "04",
      key: "ntfyExtractedFetch",
      label: "ntfy health / extracted fetch",
      invoke: (url, init) => extractedFetch(url, init),
    },
    {
      id: "05",
      key: "ntfyClientStyleFetch",
      label: "ntfy health / NtfyClient fetchImpl",
      invoke: (url, init) => clientStyle.fetchImpl(url, init),
    },
  ];

  for (const probe of healthProbes) {
    report.tests.push(await runFetchProbe({
      ...probe,
      url: healthUrl,
      init: healthInit,
      timeoutMs,
    }));
  }

  return report;
}

export async function runNtfyPublishDiagnostic({
  serverUrl,
  topic,
  scope = globalThis,
  timeoutMs = DIAGNOSTIC_TIMEOUT_MS,
}) {
  const payload = {
    topic,
    title: "Circle Planner",
    message: "Circle Planner通信診断",
  };
  const publishUrl = createNtfyGetPublishUrl(serverUrl, payload);
  const client = new NtfyClient({
    fetchImpl: scope.fetch,
    timeoutMs,
    diagnosticLogger: () => {},
  });

  try {
    const result = await client.publishTest(serverUrl, payload);
    return {
      id: "06",
      key: "ntfyPublishDiagnostic",
      label: "ntfy通知送信診断（1回）",
      result: "SUCCESS",
      method: result.method || "GET",
      mode: result.mode || "no-cors",
      status: result.status ?? 0,
      statusText: "",
      responseType: result.responseType || "unknown",
      responseOrigin: safeOrigin(serverUrl),
      verification: result.httpVerified ? "HTTP_VERIFIED" : "UNVERIFIED",
    };
  } catch (error) {
    return createFailureResult({
      id: "06",
      key: "ntfyPublishDiagnostic",
      label: "ntfy通知送信診断（1回）",
      method: "GET",
      mode: "no-cors",
      error,
      timedOut: error?.timedOut === true,
      secrets: [topic, publishUrl],
    });
  }
}

export function formatCommunicationDiagnostics(report) {
  const lines = [
    "Circle Planner Communication Diagnostics",
    `release=${sanitizeValue(report.release)}`,
    `displayMode=${report.displayMode}`,
    `standalone=${report.standalone}`,
    `online=${report.online}`,
    `origin=${report.origin}`,
    `serviceWorkerControlled=${report.serviceWorkerControlled}`,
  ];

  for (const test of report.tests) {
    lines.push("", `${test.id} ${test.label}`, `key=${test.key}`, `result=${test.result}`);
    lines.push(`method=${test.method}`, `mode=${test.mode}`);
    if (test.result === "SUCCESS") {
      lines.push(
        `status=${test.status}`,
        `statusText=${sanitizeValue(test.statusText)}`,
        `responseType=${test.responseType}`,
        `responseOrigin=${test.responseOrigin}`,
      );
      if (test.verification) lines.push(`verification=${test.verification}`);
    } else {
      if (test.status !== undefined) lines.push(`status=${test.status}`);
      if (test.statusText !== undefined) lines.push(`statusText=${sanitizeValue(test.statusText)}`);
      if (test.responseType !== undefined) lines.push(`responseType=${test.responseType}`);
      if (test.responseOrigin !== undefined) lines.push(`responseOrigin=${test.responseOrigin}`);
      lines.push(
        `errorKind=${test.errorKind}`,
        `errorName=${sanitizeValue(test.errorName)}`,
        `errorMessage=${sanitizeValue(test.errorMessage)}`,
        `errorConstructor=${sanitizeValue(test.errorConstructor)}`,
        `isTypeError=${test.isTypeError}`,
        `isAbortError=${test.isAbortError}`,
        `timeout=${test.timeout}`,
      );
    }
  }

  return lines.join("\n");
}

async function runFetchProbe({ id, key, label, url, init, invoke, timeoutMs }) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  let timeoutId = null;
  const timeoutError = new Error("Diagnostic request timed out");
  timeoutError.name = "TimeoutError";

  try {
    const requestPromise = Promise.resolve().then(() => invoke(url, {
      ...init,
      signal: controller?.signal,
    }));
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        reject(timeoutError);
      }, timeoutMs);
    });
    const response = await Promise.race([requestPromise, timeoutPromise]);
    const status = Number.isInteger(response?.status) ? response.status : null;
    const responseType = response?.type || "unknown";
    if (responseType !== "opaque" && response?.ok === false) {
      return {
        id,
        key,
        label,
        result: "ERROR",
        method: init.method || "GET",
        mode: init.mode || "cors",
        status,
        statusText: sanitizeValue(response?.statusText),
        responseType,
        responseOrigin: safeOrigin(response?.url),
        errorKind: status >= 500 ? "http-server" : "http-client",
        errorName: "HttpError",
        errorMessage: `HTTP ${status ?? "unknown"}`,
        errorConstructor: "Response",
        isTypeError: false,
        isAbortError: false,
        timeout: false,
      };
    }
    return {
      id,
      key,
      label,
      result: "SUCCESS",
      method: init.method || "GET",
      mode: init.mode || "cors",
      status,
      statusText: sanitizeValue(response?.statusText),
      responseType,
      responseOrigin: safeOrigin(response?.url),
      verification: responseType === "opaque" ? "UNVERIFIED" : undefined,
    };
  } catch (error) {
    return createFailureResult({
      id,
      key,
      label,
      method: init.method || "GET",
      mode: init.mode || "cors",
      error,
      timedOut,
    });
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function createFailureResult({
  id,
  key,
  label,
  method,
  mode,
  error,
  timedOut,
  secrets = [],
}) {
  const rootError = deepestCause(error);
  const errorName = String(rootError?.name || "Error");
  return {
    id,
    key,
    label,
    result: "ERROR",
    method,
    mode,
    errorKind: timedOut ? "timeout" : "network",
    errorName: sanitizeValue(errorName, secrets),
    errorMessage: sanitizeValue(rootError?.message || String(rootError), secrets),
    errorConstructor: sanitizeValue(rootError?.constructor?.name || "unknown", secrets),
    isTypeError: rootError instanceof TypeError || errorName === "TypeError",
    isAbortError: errorName === "AbortError",
    timeout: timedOut,
  };
}

function deepestCause(error) {
  let current = error;
  const seen = new Set();
  while (current?.cause && !seen.has(current.cause)) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}

function safeOrigin(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return "unknown";
  }
}

function sanitizeValue(value, secrets = []) {
  let text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  for (const secret of secrets.filter(Boolean)) {
    for (const candidate of [String(secret), encodeURIComponent(String(secret))]) {
      text = text.split(candidate).join("[redacted]");
    }
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => safeOrigin(match));
  return text.slice(0, 500);
}
