export const NTFY_INTEGRATION_KEY = "ntfy";
export const DEFAULT_NTFY_SERVER_URL = "https://ntfy.sh";
export const NTFY_MIN_DELAY_MS = 10 * 1000;
export const NTFY_MAX_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 12_000;

export function defaultNtfyIntegration() {
  return {
    version: 1,
    enabled: false,
    serverUrl: DEFAULT_NTFY_SERVER_URL,
    topic: "",
    leadMinutes: 0,
    scheduled: {},
    pending: {},
    pendingCancels: [],
    lastSyncAt: null,
    lastError: "",
  };
}

export function normalizeNtfyIntegration(rawValue) {
  const raw = rawValue && typeof rawValue === "object" ? rawValue : {};
  return {
    ...defaultNtfyIntegration(),
    ...raw,
    enabled: raw.enabled === true,
    serverUrl:
      typeof raw.serverUrl === "string" && raw.serverUrl.trim()
        ? raw.serverUrl.trim()
        : DEFAULT_NTFY_SERVER_URL,
    topic: typeof raw.topic === "string" ? raw.topic.trim() : "",
    leadMinutes: 0,
    scheduled: normalizeRecordMap(raw.scheduled),
    pending: normalizeRecordMap(raw.pending),
    pendingCancels: Array.isArray(raw.pendingCancels)
      ? raw.pendingCancels.filter((item) => item && typeof item === "object").map((item) => ({ ...item }))
      : [],
    lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : "",
  };
}

function normalizeRecordMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, record]) => record && typeof record === "object")
      .map(([key, record]) => [key, { ...record }]),
  );
}

export function normalizeServerUrl(value) {
  const url = new URL(String(value ?? "").trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("ntfyサーバーURLはhttpまたはhttpsのURLで入力してください。");
  }
  return url.href.replace(/\/+$/, "");
}

export function createNtfyJsonPublishUrl(serverUrl) {
  return `${normalizeServerUrl(serverUrl)}/`;
}

export function validateNtfySettings(settings) {
  try {
    normalizeServerUrl(settings?.serverUrl || DEFAULT_NTFY_SERVER_URL);
  } catch {
    return "ntfyサーバーURLを確認してください。";
  }

  const topic = String(settings?.topic ?? "").trim();
  if (settings?.enabled && !topic) return "通知をONにするにはトピック名を入力してください。";
  if (topic && (topic.length > 64 || !/^[-_A-Za-z0-9]+$/.test(topic))) {
    return "トピック名は英数字・ハイフン・アンダースコアで64文字以内にしてください。";
  }
  return "";
}

export function createSequenceId(eventId) {
  const source = String(eventId ?? "");
  if (/^[A-Za-z0-9_-]{1,48}$/.test(source)) return `cp-${source}`;

  const readable = source.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36);
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const suffix = (hash >>> 0).toString(16).padStart(8, "0");
  return `cp-${readable || "event"}-${suffix}`;
}

export function eventStartDate(event) {
  const [year, month, day] = String(event.date).split("-").map(Number);
  const [hours, minutes] = String(event.startTime).split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

export function eventStartUnixTimestamp(event) {
  return Math.floor(eventStartDate(event).getTime() / 1000);
}

export function classifyNotificationTiming(event, now = new Date()) {
  const delayMs = eventStartDate(event).getTime() - now.getTime();
  if (delayMs <= 0) return { status: "past", delayMs };
  if (delayMs < NTFY_MIN_DELAY_MS) return { status: "immediate", delayMs };
  if (delayMs <= NTFY_MAX_DELAY_MS) return { status: "schedulable", delayMs };
  return { status: "waiting", delayMs };
}

export function notificationFingerprint(event, settings) {
  return JSON.stringify([
    event.date,
    event.startTime,
    event.endTime,
    event.title,
    normalizeServerUrl(settings.serverUrl),
    settings.topic,
    0,
  ]);
}

export function createTestNotificationPayload(topic) {
  return {
    topic,
    title: "Circle Planner",
    message: "Circle Plannerからのテスト通知です",
  };
}

export function createNtfyGetPublishUrl(serverUrl, payload) {
  const baseUrl = new URL(`${normalizeServerUrl(serverUrl)}/`);
  const publishUrl = new URL(`${encodeURIComponent(payload.topic)}/publish`, baseUrl);
  publishUrl.search = new URLSearchParams({
    title: payload.title,
    message: payload.message,
  }).toString();
  return publishUrl.href;
}

export function createEventNotificationPayload(event, topic, timing) {
  const payload = {
    topic,
    title: "Circle Planner",
    message: `${event.title}\n${event.startTime}〜${event.endTime}`,
    sequence_id: createSequenceId(event.id),
  };
  if (timing === "schedulable") {
    payload.delay = String(eventStartUnixTimestamp(event));
  }
  return payload;
}

export class NtfyRequestError extends Error {
  constructor(message, {
    kind,
    method,
    mode = "cors",
    status = null,
    responseType = null,
    timedOut = false,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "NtfyRequestError";
    this.kind = kind;
    this.method = method;
    this.mode = mode;
    this.status = status;
    this.responseType = responseType;
    this.timedOut = timedOut;
  }
}

export function getNtfyTestFailureMessage(error) {
  switch (error?.kind) {
    case "timeout":
      return "ntfyから時間内に応答がありませんでした。通信状態を確認してください。";
    case "http-client":
      return "ntfyが送信内容を受け付けませんでした。サーバーURLとトピック名を確認してください。";
    case "http-server":
      return "ntfyサーバーで一時的な問題が発生しています。時間をおいて再試行してください。";
    default:
      return "ntfyへの送信に失敗しました。サーバーURLとトピック名、通信状態を確認してください。";
  }
}

function logNtfyDiagnostic(diagnostic) {
  console.error("[Circle Planner][ntfy] request failed", diagnostic);
}

export class NtfyClient {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = REQUEST_TIMEOUT_MS,
    diagnosticLogger = logNtfyDiagnostic,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetch is required.");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.diagnosticLogger = diagnosticLogger;
  }

  async publish(serverUrl, payload) {
    return this.request(createNtfyJsonPublishUrl(serverUrl), {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async publishTest(serverUrl, payload) {
    return this.requestNoCorsGet(createNtfyGetPublishUrl(serverUrl, payload));
  }

  async cancel({ serverUrl, topic, sequenceId }) {
    const endpoint = [normalizeServerUrl(serverUrl), encodeURIComponent(topic), encodeURIComponent(sequenceId), "delete"].join("/");
    return this.request(endpoint, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
    });
  }

  async request(url, init = {}) {
    const method = init.method || "GET";
    const mode = init.mode || "cors";
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    const timeout = controller
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.timeoutMs)
      : null;
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller?.signal,
      });
      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : null;
        const kind = classifyHttpFailure(status);
        throw new NtfyRequestError("ntfy returned an unsuccessful response", {
          kind,
          method,
          mode,
          status,
          responseType: response?.type || null,
        });
      }
      return response;
    } catch (error) {
      const requestError = error instanceof NtfyRequestError
        ? error
        : new NtfyRequestError(
            timedOut ? "ntfy request timed out" : "ntfy network request failed",
            {
              kind: timedOut ? "timeout" : "network",
              method,
              mode,
              timedOut,
              cause: error,
            },
          );
      this.reportFailure(requestError);
      throw requestError;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  async requestNoCorsGet(url) {
    const method = "GET";
    const mode = "no-cors";
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    const timeout = controller
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.timeoutMs)
      : null;

    try {
      const response = await this.fetchImpl(url, {
        mode,
        signal: controller?.signal,
      });
      const responseType = response?.type || null;

      // A cross-origin no-cors response is opaque. Its HTTP status and body are
      // intentionally unreadable, so this only confirms that fetch resolved.
      if (responseType === "opaque") {
        return {
          outcome: "dispatched-unverified",
          httpVerified: false,
          method,
          mode,
          responseType,
        };
      }

      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : null;
        throw new NtfyRequestError("ntfy returned an unsuccessful response", {
          kind: classifyHttpFailure(status),
          method,
          mode,
          status,
          responseType,
        });
      }

      return {
        outcome: "http-success",
        httpVerified: true,
        method,
        mode,
        responseType,
        status: response.status,
      };
    } catch (error) {
      const requestError = error instanceof NtfyRequestError
        ? error
        : new NtfyRequestError(
            timedOut ? "ntfy request timed out" : "ntfy network request failed",
            {
              kind: timedOut ? "timeout" : "network",
              method,
              mode,
              timedOut,
              cause: error,
            },
          );
      this.reportFailure(requestError);
      throw requestError;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  reportFailure(error) {
    this.diagnosticLogger?.({
      kind: error.kind,
      method: error.method,
      mode: error.mode,
      status: error.status,
      responseType: error.responseType,
      timedOut: error.timedOut,
    });
  }
}

function classifyHttpFailure(status) {
  if (status >= 500) return "http-server";
  if (status >= 400) return "http-client";
  return "http";
}

export class NtfySyncManager {
  constructor({ repository, client = new NtfyClient(), now = () => new Date() }) {
    this.repository = repository;
    this.client = client;
    this.now = now;
    this.syncChain = Promise.resolve();
  }

  getSettings() {
    return normalizeNtfyIntegration(this.repository.getIntegration(NTFY_INTEGRATION_KEY));
  }

  getStatusSummary() {
    const settings = this.getSettings();
    const nowMs = this.now().getTime();
    const scheduled = Object.values(settings.scheduled).filter(
      (record) => record.status === "scheduled" && Number(record.scheduledUnix) * 1000 > nowMs,
    ).length;
    const waiting = Object.values(settings.pending).filter((record) => record.status === "waiting").length;
    const retries =
      Object.values(settings.pending).filter((record) => record.status === "retry").length +
      settings.pendingCancels.length;
    return { settings, scheduled, waiting, retries };
  }

  saveSettings(draft) {
    const validationMessage = validateNtfySettings(draft);
    if (validationMessage) throw new TypeError(validationMessage);

    return this.enqueueOperation(async () => {
      const current = this.getSettings();
      const next = normalizeNtfyIntegration({
        ...current,
        enabled: draft.enabled === true,
        serverUrl: normalizeServerUrl(draft.serverUrl || DEFAULT_NTFY_SERVER_URL),
        topic: String(draft.topic ?? "").trim(),
      });
      const endpointChanged =
        current.serverUrl !== next.serverUrl || current.topic !== next.topic;
      if (endpointChanged || (current.enabled && !next.enabled)) {
        this.queueAllScheduledCancels(current, this.now());
        next.pendingCancels = mergeCancelQueues(current.pendingCancels, next.pendingCancels);
        next.scheduled = {};
        next.pending = {};
      }
      this.repository.setIntegration(NTFY_INTEGRATION_KEY, next);
      return this.performSync();
    });
  }

  async sendTestNotification(draft = null) {
    const settings = draft
      ? normalizeNtfyIntegration({ ...this.getSettings(), ...draft })
      : this.getSettings();
    const validationMessage = validateNtfySettings({ ...settings, enabled: true });
    if (validationMessage) throw new TypeError(validationMessage);
    return this.client.publishTest(
      settings.serverUrl,
      createTestNotificationPayload(settings.topic),
    );
  }

  handleEventDeleted(eventId) {
    return this.enqueueOperation(async () => {
      const settings = this.getSettings();
      const record = settings.scheduled[eventId];
      if (isFutureScheduledRecord(record, this.now())) {
        settings.pendingCancels = mergeCancelQueues(settings.pendingCancels, [cancelFromRecord(record)]);
      }
      delete settings.scheduled[eventId];
      delete settings.pending[eventId];
      this.repository.setIntegration(NTFY_INTEGRATION_KEY, settings);
      return this.performSync();
    });
  }

  syncAll() {
    return this.enqueueOperation(() => this.performSync());
  }

  enqueueOperation(operation) {
    this.syncChain = this.syncChain.catch(() => undefined).then(operation);
    return this.syncChain;
  }

  async performSync() {
    let settings = this.getSettings();
    const attemptedCancelKeys = new Set(settings.pendingCancels.map(cancelQueueKey));
    settings = await this.processPendingCancels(settings);

    const validationMessage = validateNtfySettings(settings);
    if (!settings.enabled || validationMessage) {
      settings.lastSyncAt = this.now().toISOString();
      if (settings.enabled && validationMessage) {
        settings.lastError = validationMessage;
      } else if (!settings.pendingCancels.length) {
        settings.lastError = "";
      }
      this.repository.setIntegration(NTFY_INTEGRATION_KEY, settings);
      return this.getStatusSummary();
    }

    const events = this.repository.getAll();
    const eventIds = new Set(events.map((event) => event.id));
    for (const [eventId, record] of Object.entries(settings.scheduled)) {
      if (eventIds.has(eventId)) continue;
      if (isFutureScheduledRecord(record, this.now())) {
        settings.pendingCancels = mergeCancelQueues(settings.pendingCancels, [cancelFromRecord(record)]);
      }
      delete settings.scheduled[eventId];
      delete settings.pending[eventId];
    }

    let lastError = "";
    for (const event of events) {
      const result = await this.syncEvent(event, settings);
      settings = result.settings;
      if (result.error) lastError = result.error;
    }

    settings = await this.processPendingCancels(settings, attemptedCancelKeys);
    settings.lastSyncAt = this.now().toISOString();
    settings.lastError = settings.pendingCancels.length || Object.values(settings.pending).some((item) => item.status === "retry")
      ? lastError || settings.lastError || "一部の通知をntfyへ反映できていません。"
      : "";
    this.repository.setIntegration(NTFY_INTEGRATION_KEY, settings);
    return this.getStatusSummary();
  }

  async syncEvent(event, settings) {
    const now = this.now();
    const timing = classifyNotificationTiming(event, now);
    const existing = settings.scheduled[event.id];
    const fingerprint = notificationFingerprint(event, settings);
    const sequenceId = createSequenceId(event.id);

    if (timing.status === "past") {
      delete settings.scheduled[event.id];
      delete settings.pending[event.id];
      return { settings };
    }

    if (timing.status === "waiting") {
      if (isFutureScheduledRecord(existing, now)) {
        settings.pendingCancels = mergeCancelQueues(settings.pendingCancels, [cancelFromRecord(existing)]);
      }
      delete settings.scheduled[event.id];
      settings.pending[event.id] = {
        status: "waiting",
        sequenceId,
        fingerprint,
        notificationUnix: eventStartUnixTimestamp(event),
        updatedAt: now.toISOString(),
        lastError: "",
      };
      return { settings };
    }

    if (existing?.fingerprint === fingerprint && ["scheduled", "sent"].includes(existing.status)) {
      delete settings.pending[event.id];
      return { settings };
    }

    try {
      await this.client.publish(
        settings.serverUrl,
        createEventNotificationPayload(event, settings.topic, timing.status),
      );
      settings.scheduled[event.id] = {
        status: timing.status === "immediate" ? "sent" : "scheduled",
        sequenceId,
        fingerprint,
        serverUrl: settings.serverUrl,
        topic: settings.topic,
        scheduledUnix: eventStartUnixTimestamp(event),
        updatedAt: now.toISOString(),
      };
      delete settings.pending[event.id];
      return { settings };
    } catch {
      settings.pending[event.id] = {
        status: "retry",
        sequenceId,
        fingerprint,
        notificationUnix: eventStartUnixTimestamp(event),
        updatedAt: now.toISOString(),
        lastError: "ntfyへの通知予約に失敗しました。",
      };
      return { settings, error: "一部の通知をntfyへ予約できていません。" };
    }
  }

  async processPendingCancels(settings, skippedKeys = new Set()) {
    const remaining = [];
    for (const pendingCancel of settings.pendingCancels) {
      if (skippedKeys.has(cancelQueueKey(pendingCancel))) {
        remaining.push(pendingCancel);
        continue;
      }
      try {
        await this.client.cancel(pendingCancel);
      } catch {
        remaining.push({
          ...pendingCancel,
          attempts: Number(pendingCancel.attempts || 0) + 1,
          lastAttemptAt: this.now().toISOString(),
          lastError: "ntfyの通知キャンセルに失敗しました。",
        });
      }
    }
    settings.pendingCancels = remaining;
    if (remaining.length) settings.lastError = "一部の通知キャンセルを再試行します。";
    this.repository.setIntegration(NTFY_INTEGRATION_KEY, settings);
    return settings;
  }

  queueAllScheduledCancels(settings, now) {
    const cancels = Object.values(settings.scheduled)
      .filter((record) => isFutureScheduledRecord(record, now))
      .map(cancelFromRecord);
    settings.pendingCancels = mergeCancelQueues(settings.pendingCancels, cancels);
  }
}

function isFutureScheduledRecord(record, now) {
  return Boolean(
    record?.status === "scheduled" &&
      record.serverUrl &&
      record.topic &&
      record.sequenceId &&
      Number(record.scheduledUnix) * 1000 > now.getTime(),
  );
}

function cancelFromRecord(record) {
  return {
    serverUrl: record.serverUrl,
    topic: record.topic,
    sequenceId: record.sequenceId,
    scheduledUnix: record.scheduledUnix,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
}

function mergeCancelQueues(...queues) {
  const records = new Map();
  for (const queue of queues) {
    for (const record of queue || []) {
      if (!record?.serverUrl || !record?.topic || !record?.sequenceId) continue;
      const key = cancelQueueKey(record);
      records.set(key, { ...records.get(key), ...record });
    }
  }
  return [...records.values()];
}

function cancelQueueKey(record) {
  return `${record.serverUrl}|${record.topic}|${record.sequenceId}`;
}
