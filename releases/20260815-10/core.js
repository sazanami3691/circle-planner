export const MINUTES_PER_DAY = 24 * 60;
export const EVENT_LABEL_MIN_FONT_SIZE = 10;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

export function isValidDate(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isValidTime(value) {
  const match = TIME_PATTERN.exec(value);
  if (!match) return false;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

export function timeToMinutes(value) {
  if (!isValidTime(value)) {
    throw new TypeError(`Invalid time: ${value}`);
  }

  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function clockHourFromPoint(
  x,
  y,
  { centerX = 300, centerY = 300, innerRadius = 78, outerRadius = 220 } = {},
) {
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  const distance = Math.hypot(deltaX, deltaY);

  if (distance < innerRadius || distance > outerRadius) return null;

  const fullTurn = Math.PI * 2;
  const clockwiseAngleFromTop = (Math.atan2(deltaY, deltaX) + Math.PI / 2 + fullTurn) % fullTurn;
  return Math.floor((clockwiseAngleFromTop / fullTurn) * 24) % 24;
}

export function clockHourToTimeRange(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`Invalid clock hour: ${hour}`);
  }

  const startTime = `${String(hour).padStart(2, "0")}:00`;
  const endTime = `${String((hour + 1) % 24).padStart(2, "0")}:00`;
  return { startTime, endTime };
}

export function clockHourToAvailableTimeRange(hour, visibleSegments = []) {
  const fallbackRange = clockHourToTimeRange(hour);
  const slotStart = hour * 60;
  const slotEnd = slotStart + 60;
  const latestEnd = visibleSegments
    .filter(
      (segment) =>
        Number.isFinite(segment?.startMinute) &&
        Number.isFinite(segment?.endMinute) &&
        segment.startMinute < slotEnd &&
        segment.endMinute > slotStart &&
        segment.endMinute <= slotEnd,
    )
    .reduce((latest, segment) => Math.max(latest, segment.endMinute), slotStart);

  if (latestEnd <= slotStart || latestEnd >= slotEnd) return fallbackRange;

  const startHour = Math.floor(latestEnd / 60) % 24;
  const startMinute = latestEnd % 60;
  return {
    startTime: `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`,
    endTime: fallbackRange.endTime,
  };
}

export function truncateLabel(value, maxCharacters) {
  const characters = Array.from(String(value ?? ""));
  if (characters.length <= maxCharacters) return characters.join("");
  if (maxCharacters <= 1) return "…";
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function centeredAxisSpan(primarySize, primaryComponent, secondarySize, secondaryComponent) {
  const primaryLimit =
    primaryComponent < 0.001 ? Number.POSITIVE_INFINITY : primarySize / primaryComponent;
  const secondaryLimit =
    secondaryComponent < 0.001 ? Number.POSITIVE_INFINITY : secondarySize / secondaryComponent;
  return Math.min(primaryLimit, secondaryLimit);
}

export function getScheduleEventLabelLayout({
  title,
  startMinute,
  endMinute,
  innerRadius,
  outerRadius,
}) {
  const duration = endMinute - startMinute;
  const fontSize = duration >= 60 ? 14 : duration >= 30 ? 12 : EVENT_LABEL_MIN_FONT_SIZE;
  const radialWidth = Math.max(0, outerRadius - innerRadius);
  const labelRadius = Math.max(innerRadius, outerRadius - Math.min(10, radialWidth * 0.25));
  const midpoint = (startMinute + endMinute) / 2;
  const angle = (midpoint / MINUTES_PER_DAY) * Math.PI * 2 - Math.PI / 2;
  const tangentialWidth = Math.max(
    0,
    labelRadius * ((duration / MINUTES_PER_DAY) * Math.PI * 2),
  );
  const absoluteCosine = Math.abs(Math.cos(angle));
  const absoluteSine = Math.abs(Math.sin(angle));
  const horizontalCapacity = centeredAxisSpan(
    radialWidth,
    absoluteCosine,
    tangentialWidth,
    absoluteSine,
  );
  const verticalCapacity = centeredAxisSpan(
    radialWidth,
    absoluteSine,
    tangentialWidth,
    absoluteCosine,
  );
  const maxCharacters = Math.max(
    0,
    Math.min(12, Math.floor(horizontalCapacity / (fontSize * 0.9))),
  );
  const titleLength = Array.from(String(title ?? "")).length;
  const minimumCharacters = Math.min(2, titleLength);
  const canRenderInside =
    duration >= 12 &&
    radialWidth >= fontSize * 1.4 &&
    verticalCapacity >= fontSize * 0.9 &&
    maxCharacters >= minimumCharacters;

  return {
    placement: canRenderInside ? "inside" : "outside",
    fontSize,
    labelRadius,
    maxCharacters,
    midpoint,
    side: Math.cos(angle) >= 0 ? "right" : "left",
    text: truncateLabel(title, canRenderInside ? maxCharacters : 6),
  };
}

function moveBelowReservedPosition(value, reservedPositions, gap) {
  let result = value;
  for (const reserved of reservedPositions) {
    if (result > reserved - gap && result < reserved + gap) {
      result = reserved + gap;
    }
  }
  return result;
}

function moveAboveReservedPosition(value, reservedPositions, gap) {
  let result = value;
  for (const reserved of [...reservedPositions].reverse()) {
    if (result > reserved - gap && result < reserved + gap) {
      result = reserved - gap;
    }
  }
  return result;
}

export function layoutExternalEventLabels(
  labels,
  { minY = 36, maxY = 564, gap = 18, reservedY = [110, 300, 490] } = {},
) {
  const positioned = labels.map((label, index) => ({ ...label, index, y: label.idealY }));

  for (const side of ["left", "right"]) {
    const sideLabels = positioned
      .filter((label) => label.side === side)
      .sort((a, b) => a.idealY - b.idealY || a.index - b.index);

    let previousY = Number.NEGATIVE_INFINITY;
    for (const label of sideLabels) {
      const requestedY = Math.max(minY, Math.min(maxY, label.idealY), previousY + gap);
      label.y = moveBelowReservedPosition(requestedY, reservedY, gap);
      previousY = label.y;
    }

    let nextY = Number.POSITIVE_INFINITY;
    for (let index = sideLabels.length - 1; index >= 0; index -= 1) {
      const label = sideLabels[index];
      const requestedY = Math.min(label.y, maxY, nextY - gap);
      label.y = moveAboveReservedPosition(requestedY, reservedY, gap);
      nextY = label.y;
    }
  }

  return positioned.sort((a, b) => a.index - b.index).map(({ index, ...label }) => label);
}

export function addDays(dateString, amount) {
  if (!isValidDate(dateString)) {
    throw new TypeError(`Invalid date: ${dateString}`);
  }

  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function eventDurationMinutes(event) {
  const start = timeToMinutes(event.startTime);
  const end = timeToMinutes(event.endTime);

  if (start === end) return 0;
  return end > start ? end - start : MINUTES_PER_DAY - start + end;
}

export function isOvernightEvent(event) {
  return timeToMinutes(event.endTime) < timeToMinutes(event.startTime);
}

export function validateEventDraft(event) {
  if (!event || typeof event !== "object") {
    return "予定の内容を確認してください。";
  }
  if (typeof event.title !== "string" || !event.title.trim()) {
    return "予定名を入力してください。";
  }
  if (!isValidDate(event.date)) {
    return "日付が正しくありません。";
  }
  if (!isValidTime(event.startTime) || !isValidTime(event.endTime)) {
    return "開始時刻と終了時刻を確認してください。";
  }
  if (event.startTime === event.endTime) {
    return "開始時刻と終了時刻は別の時刻にしてください。";
  }
  if (typeof event.category !== "string" || !event.category.trim()) {
    return "カテゴリーを入力してください。";
  }
  if (!/^#[0-9a-f]{6}$/i.test(event.color)) {
    return "表示色を選択してください。";
  }
  return "";
}

export function normalizeEvent(rawEvent) {
  const event = {
    ...rawEvent,
    id: String(rawEvent?.id ?? ""),
    date: String(rawEvent?.date ?? ""),
    title: String(rawEvent?.title ?? "").trim(),
    startTime: String(rawEvent?.startTime ?? ""),
    endTime: String(rawEvent?.endTime ?? ""),
    category: String(rawEvent?.category ?? "").trim(),
    color: String(rawEvent?.color ?? "").toLowerCase(),
    externalIds:
      rawEvent?.externalIds && typeof rawEvent.externalIds === "object"
        ? { ...rawEvent.externalIds }
        : {},
  };

  if (!event.id) {
    throw new TypeError("Event id is required.");
  }

  const validationMessage = validateEventDraft(event);
  if (validationMessage) {
    throw new TypeError(validationMessage);
  }

  return event;
}

export function getVisibleEventSegments(events, selectedDate) {
  const previousDate = addDays(selectedDate, -1);
  const segments = [];

  for (const event of events) {
    const start = timeToMinutes(event.startTime);
    const end = timeToMinutes(event.endTime);

    if (event.date === selectedDate) {
      segments.push({
        event,
        startMinute: start,
        endMinute: end > start ? end : MINUTES_PER_DAY,
        continuesFromPrevious: false,
        continuesToNext: end < start,
      });
    }

    if (event.date === previousDate && end < start && end > 0) {
      segments.push({
        event,
        startMinute: 0,
        endMinute: end,
        continuesFromPrevious: true,
        continuesToNext: false,
      });
    }
  }

  return segments.sort(
    (a, b) =>
      a.startMinute - b.startMinute ||
      a.endMinute - b.endMinute ||
      a.event.title.localeCompare(b.event.title, "ja"),
  );
}

export function assignOverlapTracks(segments) {
  const trackEnds = [];
  const assigned = segments.map((segment) => {
    let trackIndex = trackEnds.findIndex((endMinute) => segment.startMinute >= endMinute);

    if (trackIndex === -1) {
      trackIndex = trackEnds.length;
      trackEnds.push(segment.endMinute);
    } else {
      trackEnds[trackIndex] = segment.endMinute;
    }

    return { ...segment, trackIndex };
  });

  const trackCount = Math.max(1, trackEnds.length);
  return assigned.map((segment) => ({ ...segment, trackCount }));
}

export function formatDuration(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}分`;
  if (minutes === 0) return `${hours}時間`;
  return `${hours}時間${minutes}分`;
}
