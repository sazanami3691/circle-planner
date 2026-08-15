import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_LABEL_MIN_FONT_SIZE,
  addDays,
  assignOverlapTracks,
  clockHourToAvailableTimeRange,
  clockHourFromPoint,
  clockHourToTimeRange,
  eventDurationMinutes,
  getScheduleEventLabelLayout,
  getVisibleEventSegments,
  layoutExternalEventLabels,
  timeToMinutes,
  truncateLabel,
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

test("円タップは時間枠内で最も遅い予定終了時刻から開始する", () => {
  const segment = (startMinute, endMinute) => ({ startMinute, endMinute });
  for (const [label, hour, segments, expected] of [
    ["予定なし", 6, [], { startTime: "06:00", endTime: "07:00" }],
    ["1件", 6, [segment(360, 375)], { startTime: "06:15", endTime: "07:00" }],
    [
      "連続",
      6,
      [segment(360, 375), segment(375, 390)],
      { startTime: "06:30", endTime: "07:00" },
    ],
    [
      "複数",
      6,
      [segment(360, 375), segment(390, 405)],
      { startTime: "06:45", endTime: "07:00" },
    ],
    ["前の時間から継続", 6, [segment(330, 375)], { startTime: "06:15", endTime: "07:00" }],
    ["時間枠を通過", 6, [segment(330, 435)], { startTime: "06:00", endTime: "07:00" }],
    ["23時台", 23, [segment(1380, 1395)], { startTime: "23:15", endTime: "00:00" }],
    ["枠全体", 6, [segment(360, 420)], { startTime: "06:00", endTime: "07:00" }],
    ["枠末尾まで", 6, [segment(390, 420)], { startTime: "06:00", endTime: "07:00" }],
  ]) {
    assert.deepEqual(clockHourToAvailableTimeRange(hour, segments), expected, label);
  }
});

test("前日から続く予定の終了時刻を当日0時台の開始候補にする", () => {
  const overnight = {
    ...baseEvent,
    date: "2026-08-12",
    startTime: "23:30",
    endTime: "00:15",
  };
  const segments = getVisibleEventSegments([overnight], "2026-08-13");
  assert.deepEqual(clockHourToAvailableTimeRange(0, segments), {
    startTime: "00:15",
    endTime: "01:00",
  });
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

test("予定時間に応じて円内タイトルの文字サイズを段階的に調整する", () => {
  const layout = (duration, title = "朝食") =>
    getScheduleEventLabelLayout({
      title,
      startMinute: 360,
      endMinute: 360 + duration,
      innerRadius: 83,
      outerRadius: 218,
    });

  assert.deepEqual([layout(60).placement, layout(60).fontSize], ["inside", 14]);
  assert.deepEqual([layout(30).placement, layout(30).fontSize], ["inside", 12]);
  assert.deepEqual(
    [layout(15).placement, layout(15).fontSize],
    ["inside", EVENT_LABEL_MIN_FONT_SIZE],
  );
});

test("短すぎる予定や細い重複トラックは円外タイトルへ切り替える", () => {
  const shortLayout = getScheduleEventLabelLayout({
    title: "短い予定",
    startMinute: 360,
    endMinute: 370,
    innerRadius: 83,
    outerRadius: 218,
  });
  const thinTrackLayout = getScheduleEventLabelLayout({
    title: "重複予定",
    startMinute: 360,
    endMinute: 420,
    innerRadius: 197,
    outerRadius: 218,
  });
  const leftLayout = getScheduleEventLabelLayout({
    title: "左側の短い予定",
    startMinute: 1080,
    endMinute: 1090,
    innerRadius: 83,
    outerRadius: 218,
  });

  assert.equal(shortLayout.placement, "outside");
  assert.equal(shortLayout.side, "right");
  assert.equal(thinTrackLayout.placement, "outside");
  assert.equal(leftLayout.placement, "outside");
  assert.equal(leftLayout.side, "left");
});

test("円外タイトルは左右を分け、近接ラベルと時刻数字を避けて配置する", () => {
  const layouts = layoutExternalEventLabels([
    { side: "right", idealY: 298, id: "right-1" },
    { side: "right", idealY: 304, id: "right-2" },
    { side: "left", idealY: 300, id: "left-1" },
  ]);
  const [rightFirst, rightSecond, left] = layouts;

  assert.ok(rightSecond.y - rightFirst.y >= 18);
  assert.ok(Math.abs(rightFirst.y - 300) >= 18);
  assert.ok(Math.abs(rightSecond.y - 300) >= 18);
  assert.ok(Math.abs(left.y - 300) >= 18);
});

test("長い予定タイトルは表示可能文字数で省略する", () => {
  assert.equal(truncateLabel("朝のゲーム制作", 5), "朝のゲー…");
  assert.equal(truncateLabel("朝食", 5), "朝食");
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
