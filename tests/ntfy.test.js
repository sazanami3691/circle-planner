import test from "node:test";
import assert from "node:assert/strict";

import {
  NTFY_MAX_DELAY_MS,
  NTFY_MIN_DELAY_MS,
  NtfyClient,
  NtfyRequestError,
  NtfySyncManager,
  classifyNotificationTiming,
  createEventNotificationPayload,
  createNtfyGetPublishUrl,
  createSequenceId,
  createTestNotificationPayload,
  defaultNtfyIntegration,
  eventStartDate,
  eventStartUnixTimestamp,
  getNtfyTestFailureMessage,
} from "../js/ntfy.js";
import { ScheduleRepository, STORAGE_KEY } from "../js/storage.js";

const baseEvent = {
  id: "event-1",
  date: "2026-08-15",
  title: "ゲーム制作",
  startTime: "19:07",
  endTime: "20:13",
  category: "制作",
  color: "#4aa8d8",
  externalIds: { futureProvider: "keep-me" },
};

class MemoryStorage {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial));
  }

  getItem(key) {
    return this.data.get(key) ?? null;
  }

  setItem(key, value) {
    this.data.set(key, String(value));
  }
}

function createRepository(storage = new MemoryStorage()) {
  const repository = new ScheduleRepository(storage);
  repository.load();
  return { repository, storage };
}

function configuredSettings(overrides = {}) {
  return {
    ...defaultNtfyIntegration(),
    enabled: true,
    serverUrl: "https://ntfy.sh",
    topic: "circle-planner-test-topic",
    ...overrides,
  };
}

function createFetchMock() {
  const calls = [];
  const diagnostics = [];
  const behavior = {
    failPost: false,
    failGet: false,
    postStatus: 200,
    getStatus: 200,
  };
  const fetchImpl = async (url, init) => {
    const method = init.method || "GET";
    calls.push({ url, init, payload: init.body ? JSON.parse(init.body) : null });
    if ((method === "POST" && behavior.failPost) || (method === "GET" && behavior.failGet)) {
      throw new TypeError("Failed to fetch");
    }
    const status = method === "POST" ? behavior.postStatus : behavior.getStatus;
    return { type: "cors", ok: status >= 200 && status < 300, status };
  };
  return { calls, behavior, diagnostics, fetchImpl };
}

function createTestClient(mock, options = {}) {
  return new NtfyClient({
    fetchImpl: mock.fetchImpl,
    diagnosticLogger: (diagnostic) => mock.diagnostics.push(diagnostic),
    ...options,
  });
}

function fixedNow() {
  return new Date(2026, 7, 15, 18, 0, 0, 0);
}

test("デフォルトfetchはglobalThisへbindし、注入fetchはそのまま保持する", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  function windowLikeFetch(url, init) {
    if (this !== globalThis) {
      throw new TypeError("Can only call Window.fetch on instances of Window");
    }
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      type: "cors",
      url,
    });
  }

  const wrongReceiver = { fetchImpl: windowLikeFetch };
  assert.throws(
    () => wrongReceiver.fetchImpl("https://ntfy.sh/v1/health", {}),
    /Can only call Window\.fetch on instances of Window/,
  );
  await assert.doesNotReject(() => windowLikeFetch.bind(globalThis)("https://ntfy.sh/v1/health", {}));

  globalThis.fetch = windowLikeFetch;
  try {
    const defaultClient = new NtfyClient({ diagnosticLogger: () => {} });
    const response = await defaultClient.publishTest(
      "https://ntfy.sh",
      createTestNotificationPayload("binding-test-topic"),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).init.mode, "cors");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const injectedFetch = async () => ({ ok: true, status: 200, type: "cors" });
  const injectedClient = new NtfyClient({ fetchImpl: injectedFetch });
  assert.equal(injectedClient.fetchImpl, injectedFetch);
  await assert.doesNotReject(() => injectedClient.publishTest(
    "https://ntfy.sh",
    createTestNotificationPayload("mock-test-topic"),
  ));
});

test("ntfy OFFまたはtopic未設定では予定同期の通信を行わない", async () => {
  for (const settings of [
    configuredSettings({ enabled: false }),
    configuredSettings({ topic: "" }),
  ]) {
    const { repository } = createRepository();
    repository.upsert(baseEvent);
    repository.setIntegration("ntfy", settings);
    const mock = createFetchMock();
    const manager = new NtfySyncManager({
      repository,
      client: createTestClient(mock),
      now: fixedNow,
    });

    await manager.syncAll();
    assert.equal(mock.calls.length, 0);
  }
});

test("テスト通知はtopic・日本語title・日本語messageをURLエンコードしてGET送信する", async () => {
  const payload = createTestNotificationPayload("circle-planner-test-topic");
  assert.deepEqual(payload, {
    topic: "circle-planner-test-topic",
    title: "Circle Planner",
    message: "Circle Plannerからのテスト通知です",
  });

  const encodedTopicUrl = createNtfyGetPublishUrl("https://ntfy.sh", {
    topic: "topic/with space",
    title: "予定通知",
    message: "日本語本文",
  });
  assert.match(encodedTopicUrl, /\/topic%2Fwith%20space\/publish\?/);
  assert.match(encodedTopicUrl, /title=%E4%BA%88%E5%AE%9A%E9%80%9A%E7%9F%A5/);
  assert.match(encodedTopicUrl, /message=%E6%97%A5%E6%9C%AC%E8%AA%9E%E6%9C%AC%E6%96%87/);

  const { repository } = createRepository();
  repository.setIntegration("ntfy", configuredSettings());
  const mock = createFetchMock();
  const manager = new NtfySyncManager({
    repository,
    client: createTestClient(mock),
    now: fixedNow,
  });
  const result = await manager.sendTestNotification();

  const requestUrl = new URL(mock.calls[0].url);
  assert.equal(requestUrl.origin, "https://ntfy.sh");
  assert.equal(requestUrl.pathname, "/circle-planner-test-topic/publish");
  assert.equal(requestUrl.searchParams.get("title"), "Circle Planner");
  assert.equal(requestUrl.searchParams.get("message"), "Circle Plannerからのテスト通知です");
  assert.match(mock.calls[0].url, /title=Circle\+Planner/);
  assert.match(mock.calls[0].url, /message=Circle\+Planner%E3%81%8B%E3%82%89/);
  assert.equal(mock.calls[0].init.method, "GET");
  assert.equal(mock.calls[0].init.mode, "cors");
  assert.equal(Object.hasOwn(mock.calls[0].init, "headers"), false);
  assert.equal(Object.hasOwn(mock.calls[0].init, "cache"), false);
  assert.equal(Object.hasOwn(mock.calls[0].init, "credentials"), false);
  assert.equal(Object.hasOwn(mock.calls[0].init, "body"), false);
  assert.equal(mock.calls[0].payload, null);
  assert.equal(result.status, 200);
  assert.equal(result.type, "cors");
  assert.deepEqual(mock.diagnostics, []);
});

test("CORS GETテスト通知はfetch rejectとtimeoutを安全に診断する", async () => {
  const sensitivePayload = createTestNotificationPayload("secret-topic");

  const networkMock = createFetchMock();
  networkMock.behavior.failGet = true;
  await assert.rejects(
    createTestClient(networkMock).publishTest("https://ntfy.sh", sensitivePayload),
    (error) => error instanceof NtfyRequestError && error.kind === "network" && error.status === null,
  );
  assert.deepEqual(networkMock.diagnostics, [{
    kind: "network",
    method: "GET",
    mode: "cors",
    status: null,
    responseType: null,
    timedOut: false,
  }]);

  const timeoutDiagnostics = [];
  const timeoutClient = new NtfyClient({
    timeoutMs: 5,
    diagnosticLogger: (diagnostic) => timeoutDiagnostics.push(diagnostic),
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  await assert.rejects(
    timeoutClient.publishTest("https://ntfy.sh", sensitivePayload),
    (error) => error instanceof NtfyRequestError && error.kind === "timeout",
  );
  assert.deepEqual(timeoutDiagnostics, [{
    kind: "timeout",
    method: "GET",
    mode: "cors",
    status: null,
    responseType: null,
    timedOut: true,
  }]);

  const serializedDiagnostics = JSON.stringify([
    ...networkMock.diagnostics,
    ...timeoutDiagnostics,
  ]);
  assert.doesNotMatch(serializedDiagnostics, /secret-topic|Circle Plannerからのテスト通知です/);
  assert.match(getNtfyTestFailureMessage({ kind: "http-client" }), /サーバーURLとトピック名/);
  assert.match(getNtfyTestFailureMessage({ kind: "timeout" }), /時間内/);
});

test("CORS GETテスト通知はHTTP 4xx・5xxを失敗として検出する", async () => {
  const payload = createTestNotificationPayload("test-topic");
  for (const [status, kind] of [[400, "http-client"], [503, "http-server"]]) {
    const mock = createFetchMock();
    mock.behavior.getStatus = status;
    await assert.rejects(
      createTestClient(mock).publishTest("https://ntfy.sh", payload),
      (error) => error instanceof NtfyRequestError && error.kind === kind && error.status === status,
    );
    assert.deepEqual(mock.diagnostics, [{
      kind,
      method: "GET",
      mode: "cors",
      status,
      responseType: "cors",
      timedOut: false,
    }]);
  }
});

test("通常requestはJSON POSTの4xx・5xxを引き続き失敗として検出する", async () => {
  const payload = createEventNotificationPayload(baseEvent, "test-topic", "schedulable");

  for (const [status, kind] of [[400, "http-client"], [503, "http-server"]]) {
    const mock = createFetchMock();
    mock.behavior.postStatus = status;
    await assert.rejects(
      createTestClient(mock).publish("https://ntfy.sh", payload),
      (error) => error instanceof NtfyRequestError && error.kind === kind && error.status === status,
    );
    assert.deepEqual(mock.diagnostics, [{
      kind,
      method: "POST",
      mode: "cors",
      status,
      responseType: "cors",
      timedOut: false,
    }]);
  }
});

test("端末ローカル時刻をUnix timestampへ変換し1分単位と0時またぎを保つ", () => {
  const expected = new Date(2026, 7, 15, 19, 7, 0, 0);
  assert.equal(eventStartDate(baseEvent).getTime(), expected.getTime());
  assert.equal(eventStartUnixTimestamp(baseEvent), Math.floor(expected.getTime() / 1000));

  const overnight = { ...baseEvent, startTime: "23:00", endTime: "01:30" };
  assert.equal(eventStartDate(overnight).getTime(), new Date(2026, 7, 15, 23, 0).getTime());
  const payload = createEventNotificationPayload(overnight, "topic", "schedulable");
  assert.equal(payload.message, "ゲーム制作\n23:00〜01:30");
});

test("過去・最低遅延未満・3日以内・3日より先を分類する", () => {
  assert.equal(
    classifyNotificationTiming(baseEvent, new Date(2026, 7, 15, 19, 8)).status,
    "past",
  );
  assert.equal(
    classifyNotificationTiming(baseEvent, new Date(2026, 7, 15, 19, 6, 55)).status,
    "immediate",
  );
  assert.equal(classifyNotificationTiming(baseEvent, fixedNow()).status, "schedulable");
  assert.equal(
    classifyNotificationTiming({ ...baseEvent, date: "2026-08-19" }, fixedNow()).status,
    "waiting",
  );
  assert.equal(NTFY_MIN_DELAY_MS, 10_000);
  assert.equal(NTFY_MAX_DELAY_MS, 259_200_000);
});

test("Sequence IDは予定IDから安定して生成され編集でも変わらない", () => {
  const first = createSequenceId(baseEvent.id);
  const edited = createSequenceId({ ...baseEvent, title: "編集後" }.id);
  assert.equal(first, "cp-event-1");
  assert.equal(edited, first);
  assert.equal(createSequenceId("日本語の予定"), createSequenceId("日本語の予定"));
});

test("同一予定の再同期は増殖せず編集は同じSequence IDで置換する", async () => {
  const { repository } = createRepository();
  repository.upsert(baseEvent);
  repository.setIntegration("ntfy", configuredSettings());
  const mock = createFetchMock();
  const manager = new NtfySyncManager({
    repository,
    client: createTestClient(mock),
    now: fixedNow,
  });

  await manager.syncAll();
  await manager.syncAll();
  assert.equal(mock.calls.filter((call) => call.init.method === "POST").length, 1);

  repository.upsert({ ...baseEvent, title: "ゲーム制作・編集", startTime: "20:00" });
  await manager.syncAll();
  const publishes = mock.calls.filter((call) => call.init.method === "POST");
  assert.equal(publishes.length, 2);
  assert.equal(publishes[0].payload.delay, String(eventStartUnixTimestamp(baseEvent)));
  assert.equal(publishes[0].payload.sequence_id, publishes[1].payload.sequence_id);
  assert.equal(publishes[1].payload.message, "ゲーム制作・編集\n20:00〜20:13");
  assert.ok(publishes.every((call) => call.url === "https://ntfy.sh/"));
  assert.ok(publishes.every((call) => call.init.method === "POST"));
  assert.ok(publishes.every((call) => !Object.hasOwn(call.init, "headers")));
  assert.ok(publishes.every((call) => call.init.body === JSON.stringify(call.payload)));
});

test("予約済み予定を3日より先へ編集すると旧予約をキャンセルして待機へ戻す", async () => {
  const { repository } = createRepository();
  repository.upsert(baseEvent);
  repository.setIntegration("ntfy", configuredSettings());
  const mock = createFetchMock();
  const manager = new NtfySyncManager({
    repository,
    client: createTestClient(mock),
    now: fixedNow,
  });
  await manager.syncAll();

  repository.upsert({ ...baseEvent, date: "2026-08-25", title: "遠い予定へ変更" });
  await manager.syncAll();

  assert.equal(mock.calls.filter((call) => call.init.method === "POST").length, 1);
  assert.equal(mock.calls.filter((call) => call.init.method === "GET").length, 1);
  assert.equal(manager.getSettings().pending[baseEvent.id].status, "waiting");
  assert.equal(manager.getSettings().scheduled[baseEvent.id], undefined);
});

test("3日より先は通信せず予約可能期間待ちへ保存する", async () => {
  const { repository } = createRepository();
  repository.upsert({ ...baseEvent, date: "2026-08-25" });
  repository.setIntegration("ntfy", configuredSettings());
  const mock = createFetchMock();
  const manager = new NtfySyncManager({
    repository,
    client: createTestClient(mock),
    now: fixedNow,
  });

  await manager.syncAll();
  assert.equal(mock.calls.length, 0);
  assert.equal(manager.getSettings().pending[baseEvent.id].status, "waiting");
  assert.equal(manager.getStatusSummary().waiting, 1);
});

test("最低遅延未満の未来予定はdelayなしで即時送信し、過去予定は送らない", async () => {
  const now = () => new Date(2026, 7, 15, 19, 6, 55, 0);
  const { repository } = createRepository();
  repository.upsert(baseEvent);
  repository.upsert({ ...baseEvent, id: "past", startTime: "19:06", endTime: "19:30" });
  repository.setIntegration("ntfy", configuredSettings());
  const mock = createFetchMock();
  const manager = new NtfySyncManager({
    repository,
    client: createTestClient(mock),
    now,
  });

  await manager.syncAll();
  const publishes = mock.calls.filter((call) => call.init.method === "POST");
  assert.equal(publishes.length, 1);
  assert.equal("delay" in publishes[0].payload, false);
  assert.equal(manager.getSettings().scheduled[baseEvent.id].status, "sent");
});

test("予定削除はGETキャンセルし、失敗時は再試行情報を保持する", async () => {
  const { repository } = createRepository();
  repository.upsert(baseEvent);
  repository.setIntegration("ntfy", configuredSettings());
  const mock = createFetchMock();
  const manager = new NtfySyncManager({
    repository,
    client: createTestClient(mock),
    now: fixedNow,
  });
  await manager.syncAll();

  mock.behavior.failGet = true;
  repository.remove(baseEvent.id);
  await manager.handleEventDeleted(baseEvent.id);
  const cancelCalls = mock.calls.filter((call) => call.init.method === "GET");
  assert.equal(cancelCalls.length, 1);
  assert.match(cancelCalls[0].url, /circle-planner-test-topic\/cp-event-1\/delete$/);
  assert.equal(manager.getSettings().pendingCancels.length, 1);
  assert.equal(repository.getAll().length, 0);
});

test("通知OFFは既存予約をキャンセルし予定を維持する", async () => {
  const { repository } = createRepository();
  repository.upsert(baseEvent);
  repository.setIntegration("ntfy", configuredSettings());
  const mock = createFetchMock();
  const manager = new NtfySyncManager({
    repository,
    client: createTestClient(mock),
    now: fixedNow,
  });
  await manager.syncAll();
  await manager.saveSettings({ enabled: false, serverUrl: "https://ntfy.sh", topic: "circle-planner-test-topic" });

  assert.equal(mock.calls.filter((call) => call.init.method === "GET").length, 1);
  assert.equal(repository.getAll().length, 1);
  assert.equal(manager.getSettings().enabled, false);
});

test("topic変更は旧予約をキャンセルして新topicへ同じSequence IDで再予約する", async () => {
  const { repository } = createRepository();
  repository.upsert(baseEvent);
  repository.setIntegration("ntfy", configuredSettings({ topic: "old-topic" }));
  const mock = createFetchMock();
  const manager = new NtfySyncManager({
    repository,
    client: createTestClient(mock),
    now: fixedNow,
  });
  await manager.syncAll();
  await manager.saveSettings({ enabled: true, serverUrl: "https://ntfy.sh", topic: "new-topic" });

  const cancel = mock.calls.find((call) => call.init.method === "GET");
  const publishes = mock.calls.filter((call) => call.init.method === "POST");
  assert.match(cancel.url, /old-topic\/cp-event-1\/delete$/);
  assert.equal(publishes.at(-1).payload.topic, "new-topic");
  assert.equal(publishes[0].payload.sequence_id, publishes.at(-1).payload.sequence_id);
});

test("オフラインの通知失敗でも予定と外部連携用データを保持する", async () => {
  const { repository, storage } = createRepository();
  repository.upsert(baseEvent);
  repository.setIntegration("ntfy", configuredSettings());
  const mock = createFetchMock();
  mock.behavior.failPost = true;
  const manager = new NtfySyncManager({
    repository,
    client: createTestClient(mock),
    now: fixedNow,
  });

  await manager.syncAll();
  const reloaded = new ScheduleRepository(storage);
  const [savedEvent] = reloaded.load();
  assert.equal(savedEvent.title, baseEvent.title);
  assert.equal(savedEvent.externalIds.futureProvider, "keep-me");
  assert.equal(reloaded.getIntegration("ntfy").pending[baseEvent.id].status, "retry");
});

test("既存LocalStorage envelopeへntfy領域を追加しても未知のintegrationを維持する", () => {
  const storage = new MemoryStorage({
    [STORAGE_KEY]: JSON.stringify({
      schemaVersion: 1,
      events: [baseEvent],
      integrations: { futureCalendar: { accountId: "keep" } },
    }),
  });
  const repository = new ScheduleRepository(storage);
  repository.load();
  repository.setIntegration("ntfy", configuredSettings());

  const envelope = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(envelope.integrations.futureCalendar.accountId, "keep");
  assert.equal(envelope.integrations.ntfy.topic, "circle-planner-test-topic");
  assert.equal(envelope.events[0].externalIds.futureProvider, "keep-me");
});
