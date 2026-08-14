import test from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  assignOverlapTracks,
  clockHourFromPoint,
  clockHourToTimeRange,
  eventDurationMinutes,
  getVisibleEventSegments,
  timeToMinutes,
  validateEventDraft,
} from "../js/core.js";
import { ScheduleRepository, STORAGE_KEY } from "../js/storage.js";

const baseEvent = {
  id: "event-1",
  date: "2026-08-13",
  title: "ゲーム制作",
  startTime: "10:00",
  endTime: "12:00",
  category: "制作",
  color: "#4aa8d8",
  externalIds: {},
};

class MemoryStorage {
  constructor() {
    this.data = new Map();
  }

  getItem(key) {
    return this.data.get(key) ?? null;
  }

  setItem(key, value) {
    this.data.set(key, String(value));
  }
}

test("1分単位の時刻を分へ変換できる", () => {
  assert.equal(timeToMinutes("07:13"), 433);
  assert.equal(timeToMinutes("08:27"), 507);
});

test("円上のタップ位置を0時から時計回りの1時間枠へ変換できる", () => {
  const pointAtClockTime = (decimalHour) => {
    const angle = (decimalHour / 24) * Math.PI * 2 - Math.PI / 2;
    return {
      x: 300 + Math.cos(angle) * 150,
      y: 300 + Math.sin(angle) * 150,
    };
  };

  for (const [decimalHour, expectedHour, expectedRange] of [
    [0.5, 0, { startTime: "00:00", endTime: "01:00" }],
    [6.5, 6, { startTime: "06:00", endTime: "07:00" }],
    [12.5, 12, { startTime: "12:00", endTime: "13:00" }],
    [19 + 37 / 60, 19, { startTime: "19:00", endTime: "20:00" }],
    [23.5, 23, { startTime: "23:00", endTime: "00:00" }],
  ]) {
    const point = pointAtClockTime(decimalHour);
    assert.equal(clockHourFromPoint(point.x, point.y), expectedHour);
    assert.deepEqual(clockHourToTimeRange(expectedHour), expectedRange);
  }
});

test("中央部分と円の外側は時間枠として扱わない", () => {
  assert.equal(clockHourFromPoint(300, 300), null);
  assert.equal(clockHourFromPoint(300, 40), null);
});

test("同じ開始・終了時刻は登録できない", () => {
  assert.match(
    validateEventDraft({ ...baseEvent, startTime: "09:00", endTime: "09:00" }),
    /別の時刻/,
  );
});

test("0時をまたぐ予定の長さを計算できる", () => {
  const overnight = { ...baseEvent, startTime: "23:00", endTime: "01:30" };
  assert.equal(eventDurationMinutes(overnight), 150);
});

test("0時をまたぐ予定は開始日と翌日へ表示用に分割される", () => {
  const overnight = { ...baseEvent, startTime: "23:00", endTime: "01:30" };
  const firstDay = getVisibleEventSegments([overnight], "2026-08-13");
  const nextDay = getVisibleEventSegments([overnight], "2026-08-14");

  assert.deepEqual(
    firstDay.map(({ startMinute, endMinute, continuesToNext }) => ({
      startMinute,
      endMinute,
      continuesToNext,
    })),
    [{ startMinute: 1380, endMinute: 1440, continuesToNext: true }],
  );
  assert.deepEqual(
    nextDay.map(({ startMinute, endMinute, continuesFromPrevious }) => ({
      startMinute,
      endMinute,
      continuesFromPrevious,
    })),
    [{ startMinute: 0, endMinute: 90, continuesFromPrevious: true }],
  );
});

test("日付加算は月と年の境界を扱える", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("重複する予定は別トラックへ配置される", () => {
  const segments = [
    { event: baseEvent, startMinute: 600, endMinute: 720 },
    { event: { ...baseEvent, id: "event-2" }, startMinute: 660, endMinute: 750 },
    { event: { ...baseEvent, id: "event-3" }, startMinute: 750, endMinute: 780 },
  ];
  const assigned = assignOverlapTracks(segments);

  assert.deepEqual(
    assigned.map(({ trackIndex, trackCount }) => ({ trackIndex, trackCount })),
    [
      { trackIndex: 0, trackCount: 2 },
      { trackIndex: 1, trackCount: 2 },
      { trackIndex: 0, trackCount: 2 },
    ],
  );
});

test("予定の追加・編集・削除をローカル保存できる", () => {
  const storage = new MemoryStorage();
  const repository = new ScheduleRepository(storage);
  repository.load();

  repository.upsert(baseEvent);
  assert.equal(repository.getAll().length, 1);
  assert.match(storage.getItem(STORAGE_KEY), /ゲーム制作/);

  repository.upsert({ ...baseEvent, title: "ゲーム制作・編集済み" });
  const reloaded = new ScheduleRepository(storage);
  assert.equal(reloaded.load()[0].title, "ゲーム制作・編集済み");

  reloaded.remove(baseEvent.id);
  const afterDelete = new ScheduleRepository(storage);
  assert.equal(afterDelete.load().length, 0);
});
