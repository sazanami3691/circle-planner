import test from "node:test";
import assert from "node:assert/strict";

import {
  createNtfyHealthUrl,
  formatCommunicationDiagnostics,
  runCommunicationDiagnostics,
  runNtfyPublishDiagnostic,
} from "../js/diagnostics.js";

function diagnosticOptions(scope, overrides = {}) {
  return {
    release: "20260815-8",
    sameOriginUrl: "https://app.example/circle-planner/release.json",
    serverUrl: "https://ntfy.sh",
    scope,
    navigatorRef: {
      onLine: true,
      standalone: true,
      serviceWorker: { controller: {} },
    },
    locationRef: { origin: "https://app.example" },
    matchMediaImpl: () => ({ matches: true }),
    timeoutMs: 5,
    now: () => 123456789,
    ...overrides,
  };
}

test("ntfy health URLはtopicを使わず公式v1/healthを指す", () => {
  assert.equal(createNtfyHealthUrl("https://ntfy.sh"), "https://ntfy.sh/v1/health");
  assert.equal(
    createNtfyHealthUrl("https://notify.example/base/"),
    "https://notify.example/base/v1/health",
  );
});

test("診断は4種類のfetch receiverと同一オリジン経路を個別に実行する", async () => {
  const receivers = [];
  const scope = {};
  scope.fetch = function fetchMock(url) {
    receivers.push(this);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      type: url.includes("app.example") ? "basic" : "cors",
      url,
    });
  };

  const report = await runCommunicationDiagnostics(diagnosticOptions(scope));

  assert.deepEqual(report.tests.map((item) => item.key), [
    "sameOriginFetch",
    "ntfyGlobalFetch",
    "ntfyBoundFetch",
    "ntfyExtractedFetch",
    "ntfyClientStyleFetch",
  ]);
  assert.equal(receivers[0], scope);
  assert.equal(receivers[1], scope);
  assert.equal(receivers[2], scope);
  assert.equal(receivers[3], undefined);
  assert.equal(receivers[4], scope);
  assert.ok(report.tests.every((item) => item.result === "SUCCESS"));
  assert.equal(report.tests[0].responseType, "basic");
  assert.equal(report.tests[1].responseOrigin, "https://ntfy.sh");
  assert.equal(report.release, "20260815-8");
  assert.equal(report.standalone, true);
  assert.equal(report.serviceWorkerControlled, true);
});

test("診断はSUCCESS・TypeError・timeout・opaqueを詳細な結果へ変換する", async () => {
  let callIndex = 0;
  const scope = {};
  scope.fetch = function fetchMock(url, init) {
    callIndex += 1;
    if (callIndex === 1) {
      return Promise.resolve({ ok: true, status: 200, statusText: "OK", type: "basic", url });
    }
    if (callIndex === 2) {
      return Promise.resolve({ ok: true, status: 200, statusText: "OK", type: "cors", url });
    }
    if (callIndex === 3) throw new TypeError("Load failed");
    if (callIndex === 4) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    return Promise.resolve({ ok: false, status: 0, statusText: "", type: "opaque", url: "" });
  };

  const report = await runCommunicationDiagnostics(diagnosticOptions(scope));
  const [, globalFetch, boundFetch, extractedFetch, clientFetch] = report.tests;
  assert.equal(globalFetch.result, "SUCCESS");
  assert.equal(globalFetch.status, 200);
  assert.equal(globalFetch.responseType, "cors");
  assert.equal(boundFetch.result, "ERROR");
  assert.equal(boundFetch.errorName, "TypeError");
  assert.equal(boundFetch.errorMessage, "Load failed");
  assert.equal(boundFetch.errorConstructor, "TypeError");
  assert.equal(boundFetch.isTypeError, true);
  assert.equal(extractedFetch.result, "ERROR");
  assert.equal(extractedFetch.errorKind, "timeout");
  assert.equal(extractedFetch.errorName, "TimeoutError");
  assert.equal(extractedFetch.isAbortError, false);
  assert.equal(extractedFetch.timeout, true);
  assert.equal(clientFetch.result, "SUCCESS");
  assert.equal(clientFetch.status, 0);
  assert.equal(clientFetch.responseType, "opaque");
  assert.equal(clientFetch.verification, "UNVERIFIED");

  const text = formatCommunicationDiagnostics(report);
  assert.match(text, /ntfyGlobalFetch[\s\S]*result=SUCCESS[\s\S]*status=200/);
  assert.match(text, /ntfyBoundFetch[\s\S]*errorName=TypeError[\s\S]*errorMessage=Load failed/);
  assert.match(text, /ntfyExtractedFetch[\s\S]*errorKind=timeout/);
  assert.match(text, /ntfyClientStyleFetch[\s\S]*responseType=opaque/);
});

test("health checkのHTTPエラーはstatusと種別を保持する", async () => {
  let callIndex = 0;
  const scope = {
    fetch: async (url) => {
      callIndex += 1;
      if (callIndex === 2) {
        return { ok: false, status: 503, statusText: "Service Unavailable", type: "cors", url };
      }
      return { ok: true, status: 200, statusText: "OK", type: "cors", url };
    },
  };

  const report = await runCommunicationDiagnostics(diagnosticOptions(scope));
  const globalFetch = report.tests[1];
  assert.equal(globalFetch.result, "ERROR");
  assert.equal(globalFetch.errorKind, "http-server");
  assert.equal(globalFetch.status, 503);
  assert.equal(globalFetch.responseType, "cors");
  assert.match(formatCommunicationDiagnostics(report), /status=503[\s\S]*errorKind=http-server/);
});

test("診断はtimeout以外のAbortErrorも名前を保持する", async () => {
  let callIndex = 0;
  const scope = {};
  scope.fetch = function fetchMock(url) {
    callIndex += 1;
    if (callIndex === 3) {
      const error = new Error("Request was aborted by WebKit");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    return Promise.resolve({ ok: true, status: 200, statusText: "OK", type: "cors", url });
  };

  const report = await runCommunicationDiagnostics(diagnosticOptions(scope));
  const boundFetch = report.tests[2];
  assert.equal(boundFetch.result, "ERROR");
  assert.equal(boundFetch.errorName, "AbortError");
  assert.equal(boundFetch.isAbortError, true);
  assert.equal(boundFetch.timeout, false);
});

test("通知送信診断は1経路だけを使いtopicと完全URLを診断結果から除外する", async () => {
  const secretTopic = "private-topic-123";
  let calls = 0;
  const scope = {
    fetch(url) {
      calls += 1;
      throw new TypeError(`Load failed for ${url} topic=${secretTopic}`);
    },
  };

  const result = await runNtfyPublishDiagnostic({
    serverUrl: "https://ntfy.sh",
    topic: secretTopic,
    scope,
    timeoutMs: 5,
  });
  const report = {
    release: "20260815-8",
    displayMode: "standalone",
    standalone: true,
    online: true,
    origin: "https://app.example",
    serviceWorkerControlled: true,
    tests: [result],
  };
  const text = formatCommunicationDiagnostics(report);

  assert.equal(calls, 1);
  assert.equal(result.result, "ERROR");
  assert.equal(result.errorName, "TypeError");
  assert.match(result.errorMessage, /Load failed/);
  assert.doesNotMatch(text, new RegExp(secretTopic));
  assert.doesNotMatch(text, /\/private-topic-123\/publish/);
  assert.doesNotMatch(text, /Circle\+Planner%E9%80%9A%E4%BF%A1%E8%A8%BA%E6%96%AD/);
});

test("通知送信診断はCORSのHTTP成功を確認済みとして記録する", async () => {
  const scope = {
    fetch: async (url) => ({
      type: "cors",
      status: 200,
      statusText: "OK",
      ok: true,
      url,
    }),
  };
  const result = await runNtfyPublishDiagnostic({
    serverUrl: "https://ntfy.sh",
    topic: "test-topic",
    scope,
    timeoutMs: 5,
  });

  assert.equal(result.result, "SUCCESS");
  assert.equal(result.method, "GET");
  assert.equal(result.mode, "cors");
  assert.equal(result.status, 200);
  assert.equal(result.responseType, "cors");
  assert.equal(result.verification, "HTTP_VERIFIED");
});
