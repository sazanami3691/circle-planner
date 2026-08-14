import { normalizeEvent } from "./core.js";

export const STORAGE_KEY = "circlePlanner.schedule.v1";
export const STORAGE_SCHEMA_VERSION = 1;

function emptyEnvelope() {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    events: [],
    integrations: {},
    updatedAt: null,
  };
}

export class ScheduleRepository {
  constructor(storage) {
    this.storage = storage;
    this.envelope = emptyEnvelope();
    this.warning = "";
  }

  load() {
    this.warning = "";
    const saved = this.storage.getItem(STORAGE_KEY);
    if (!saved) {
      this.envelope = emptyEnvelope();
      return this.getAll();
    }

    try {
      const parsed = JSON.parse(saved);
      const source = Array.isArray(parsed) ? { events: parsed } : parsed;
      const events = Array.isArray(source?.events)
        ? source.events.flatMap((event) => {
            try {
              return [normalizeEvent(event)];
            } catch {
              return [];
            }
          })
        : [];

      this.envelope = {
        ...emptyEnvelope(),
        ...source,
        schemaVersion: STORAGE_SCHEMA_VERSION,
        events,
        integrations:
          source?.integrations && typeof source.integrations === "object"
            ? { ...source.integrations }
            : {},
      };
      return this.getAll();
    } catch {
      this.warning = "保存データを読み込めなかったため、画面への反映を停止しました。";
      this.envelope = emptyEnvelope();
      return this.getAll();
    }
  }

  getAll() {
    return this.envelope.events.map((event) => ({
      ...event,
      externalIds: { ...event.externalIds },
    }));
  }

  getIntegration(name) {
    const value = this.envelope.integrations?.[name];
    if (!value || typeof value !== "object") return null;
    return structuredCloneValue(value);
  }

  setIntegration(name, value) {
    if (typeof name !== "string" || !name) {
      throw new TypeError("Integration name is required.");
    }

    const integrations = {
      ...this.envelope.integrations,
      [name]: structuredCloneValue(value),
    };
    this.persist(this.envelope.events, integrations);
    return this.getIntegration(name);
  }

  upsert(rawEvent) {
    const event = normalizeEvent(rawEvent);
    const events = this.envelope.events.filter((item) => item.id !== event.id);
    events.push(event);
    this.persist(events);
    return event;
  }

  remove(id) {
    const events = this.envelope.events.filter((event) => event.id !== id);
    this.persist(events);
  }

  persist(events, integrations = this.envelope.integrations) {
    this.envelope = {
      ...this.envelope,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      events,
      integrations,
      updatedAt: new Date().toISOString(),
    };
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.envelope));
  }
}

function structuredCloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}
