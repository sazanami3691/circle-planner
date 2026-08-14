import {
  MINUTES_PER_DAY,
  addDays,
  assignOverlapTracks,
  clockHourFromPoint,
  clockHourToTimeRange,
  eventDurationMinutes,
  formatDuration,
  getVisibleEventSegments,
  isOvernightEvent,
  timeToMinutes,
  validateEventDraft,
} from "./core.js";
import { ScheduleRepository, STORAGE_KEY } from "./storage.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_COLOR = "#4aa8d8";
const SCHEDULE_CENTER = 300;
const SCHEDULE_TAP_INNER_RADIUS = 78;
const SCHEDULE_TAP_OUTER_RADIUS = 220;
const CATEGORY_COLORS = new Map([
  ["仕事", "#4aa8d8"],
  ["制作", "#a886d9"],
  ["学習", "#4fb7ad"],
  ["生活", "#d89545"],
  ["休息", "#5bae74"],
  ["その他", "#d76b72"],
]);

const elements = {
  menuToggle: document.querySelector("#menu-toggle"),
  menuLayer: document.querySelector("#menu-layer"),
  menuDrawer: document.querySelector("#app-drawer"),
  menuOverlay: document.querySelector("#menu-overlay"),
  menuClose: document.querySelector("#menu-close"),
  updateApp: document.querySelector("#update-app"),
  updateStatus: document.querySelector("#update-status"),
  addButton: document.querySelector("#open-add-dialog"),
  emptyAddButton: document.querySelector("#empty-add-button"),
  previousDay: document.querySelector("#previous-day"),
  today: document.querySelector("#today"),
  nextDay: document.querySelector("#next-day"),
  selectedDate: document.querySelector("#selected-date"),
  dateRelative: document.querySelector("#date-relative"),
  scheduleSvg: document.querySelector("#schedule-svg"),
  scheduleLayer: document.querySelector("#schedule-layer"),
  eventList: document.querySelector("#event-list"),
  eventCount: document.querySelector("#event-count"),
  emptyState: document.querySelector("#empty-state"),
  dialog: document.querySelector("#event-dialog"),
  dialogTitle: document.querySelector("#dialog-title"),
  eventDateNote: document.querySelector("#event-date-note"),
  form: document.querySelector("#event-form"),
  title: document.querySelector("#event-title"),
  startTime: document.querySelector("#event-start-time"),
  endTime: document.querySelector("#event-end-time"),
  category: document.querySelector("#event-category"),
  color: document.querySelector("#event-color"),
  palette: document.querySelector("#color-palette"),
  overnightHint: document.querySelector("#overnight-hint"),
  formError: document.querySelector("#form-error"),
  deleteButton: document.querySelector("#delete-event"),
  deleteConfirmation: document.querySelector("#delete-confirmation"),
  confirmDelete: document.querySelector("#confirm-delete"),
  cancelDelete: document.querySelector("#cancel-delete"),
  closeDialog: document.querySelector("#close-dialog"),
  cancelDialog: document.querySelector("#cancel-dialog"),
  toast: document.querySelector("#toast"),
  connectionStatus: document.querySelector("#connection-status"),
};

const repository = new ScheduleRepository(window.localStorage);
let events = repository.load();
let selectedDate = localDateString(new Date());
let editingId = null;
let toastTimer = 0;
let menuOpen = false;
let focusBeforeMenu = null;
let updateInProgress = false;

function localDateString(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function dateObject(dateString) {
  return new Date(`${dateString}T12:00:00`);
}

function formatDate(dateString) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(dateObject(dateString));
}

function relativeDateLabel(dateString) {
  const today = localDateString(new Date());
  if (dateString === today) return "今日";
  if (dateString === addDays(today, -1)) return "昨日";
  if (dateString === addDays(today, 1)) return "明日";
  return "表示中の日付";
}

function minutesToClock(minutes) {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function createId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `event-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function polarPoint(radius, minute) {
  const angle = (minute / MINUTES_PER_DAY) * Math.PI * 2 - Math.PI / 2;
  return {
    x: 300 + Math.cos(angle) * radius,
    y: 300 + Math.sin(angle) * radius,
  };
}

function annularSectorPath(innerRadius, outerRadius, startMinute, endMinute) {
  const startOuter = polarPoint(outerRadius, startMinute);
  const endOuter = polarPoint(outerRadius, endMinute);
  const endInner = polarPoint(innerRadius, endMinute);
  const startInner = polarPoint(innerRadius, startMinute);
  const largeArc = endMinute - startMinute > MINUTES_PER_DAY / 2 ? 1 : 0;

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${endInner.x} ${endInner.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${startInner.x} ${startInner.y}`,
    "Z",
  ].join(" ");
}

function readableTextColor(hexColor) {
  const [red, green, blue] = hexColor
    .slice(1)
    .match(/.{2}/g)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.42 ? "#071017" : "#ffffff";
}

function truncateLabel(value, maxCharacters) {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, Math.max(1, maxCharacters - 1)).join("")}…`;
}

function eventAriaLabel(event) {
  const overnight = isOvernightEvent(event) ? "、終了は翌日" : "";
  return `${event.title}、${event.startTime}から${event.endTime}${overnight}、${event.category}。選択して編集`;
}

function appendScheduleBase(fragment) {
  fragment.append(
    createSvgElement("circle", { cx: 300, cy: 300, r: 220, class: "schedule-face" }),
    createSvgElement("circle", { cx: 300, cy: 300, r: 165, class: "schedule-guide" }),
    createSvgElement("circle", { cx: 300, cy: 300, r: 110, class: "schedule-guide" }),
  );
}

function clientPointToSchedulePoint(event) {
  const screenMatrix = elements.scheduleSvg.getScreenCTM();
  if (!screenMatrix) return null;

  const point = elements.scheduleSvg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(screenMatrix.inverse());
}

function handleScheduleTap(event) {
  const point = clientPointToSchedulePoint(event);
  if (!point) return;

  const hour = clockHourFromPoint(point.x, point.y, {
    centerX: SCHEDULE_CENTER,
    centerY: SCHEDULE_CENTER,
    innerRadius: SCHEDULE_TAP_INNER_RADIUS,
    outerRadius: SCHEDULE_TAP_OUTER_RADIUS,
  });
  if (hour === null) return;

  openNewDialog(clockHourToTimeRange(hour));
}

function appendScheduleTapArea(fragment) {
  const radius = (SCHEDULE_TAP_INNER_RADIUS + SCHEDULE_TAP_OUTER_RADIUS) / 2;
  const strokeWidth = SCHEDULE_TAP_OUTER_RADIUS - SCHEDULE_TAP_INNER_RADIUS;
  const hitArea = createSvgElement("circle", {
    cx: SCHEDULE_CENTER,
    cy: SCHEDULE_CENTER,
    r: radius,
    fill: "none",
    stroke: "transparent",
    "stroke-width": strokeWidth,
    class: "schedule-hit-area",
    "aria-hidden": "true",
  });
  hitArea.addEventListener("click", handleScheduleTap);
  fragment.append(hitArea);
}

function appendHourMarks(fragment) {
  for (let hour = 0; hour < 24; hour += 1) {
    const isMajor = hour % 6 === 0;
    const isLabeled = hour % 3 === 0;
    const tickStart = polarPoint(isMajor ? 218 : 224, hour * 60);
    const tickEnd = polarPoint(isMajor ? 246 : 239, hour * 60);
    fragment.append(
      createSvgElement("line", {
        x1: tickStart.x,
        y1: tickStart.y,
        x2: tickEnd.x,
        y2: tickEnd.y,
        class: isMajor ? "hour-tick hour-tick--major" : "hour-tick",
      }),
    );

    if (isLabeled) {
      const labelPoint = polarPoint(268, hour * 60);
      const label = createSvgElement("text", {
        x: labelPoint.x,
        y: labelPoint.y,
        dy: "0.35em",
        class: isMajor ? "hour-label hour-label--major" : "hour-label",
      });
      label.textContent = String(hour);
      fragment.append(label);
    }
  }
}

function appendEventSectors(fragment, assignedSegments) {
  for (const segment of assignedSegments) {
    const availableRadius = 138;
    const trackThickness = Math.max(24, availableRadius / segment.trackCount);
    const outerRadius = 218 - segment.trackIndex * trackThickness;
    const innerRadius = Math.max(80, outerRadius - trackThickness + 3);
    const duration = segment.endMinute - segment.startMinute;
    const path = createSvgElement("path", {
      d: annularSectorPath(innerRadius, outerRadius, segment.startMinute, segment.endMinute),
      fill: segment.event.color,
      class: "event-sector",
      tabindex: "0",
      role: "button",
      "aria-label": eventAriaLabel(segment.event),
      "data-event-id": segment.event.id,
    });
    const title = createSvgElement("title");
    title.textContent = `${segment.event.startTime}–${segment.event.endTime} ${segment.event.title}`;
    path.append(title);
    path.addEventListener("click", (event) => {
      event.stopPropagation();
      openEditDialog(segment.event.id);
    });
    path.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openEditDialog(segment.event.id);
      }
    });
    fragment.append(path);

    const labelThreshold = segment.trackCount > 2 ? 120 : 70;
    if (duration >= labelThreshold && outerRadius - innerRadius >= 28) {
      const midpoint = (segment.startMinute + segment.endMinute) / 2;
      const labelPoint = polarPoint((innerRadius + outerRadius) / 2, midpoint);
      const maxCharacters = Math.max(3, Math.min(11, Math.floor(duration / 18)));
      const label = createSvgElement("text", {
        x: labelPoint.x,
        y: labelPoint.y,
        dy: "0.35em",
        class: "event-label",
        fill: readableTextColor(segment.event.color),
        "font-size": duration >= 150 ? 15 : 13,
      });
      label.textContent = truncateLabel(segment.event.title, maxCharacters);
      fragment.append(label);
    }
  }
}

function appendCurrentTime(fragment) {
  if (selectedDate !== localDateString(new Date())) return;

  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  const lineStart = polarPoint(72, minute);
  const lineEnd = polarPoint(218, minute);
  fragment.append(
    createSvgElement("line", {
      x1: lineStart.x,
      y1: lineStart.y,
      x2: lineEnd.x,
      y2: lineEnd.y,
      class: "current-time-line",
    }),
    createSvgElement("circle", {
      cx: lineEnd.x,
      cy: lineEnd.y,
      r: 7,
      class: "current-time-dot",
    }),
  );
}

function appendCenterSummary(fragment, segments) {
  const uniqueEvents = new Set(segments.map((segment) => segment.event.id));
  const visibleMinutes = segments.reduce(
    (sum, segment) => sum + segment.endMinute - segment.startMinute,
    0,
  );
  const count = uniqueEvents.size;
  fragment.append(createSvgElement("circle", { cx: 300, cy: 300, r: 69, class: "center-disk" }));

  const countText = createSvgElement("text", { x: 300, y: 294, class: "center-count" });
  countText.textContent = count === 0 ? "予定なし" : `${count}件`;
  const caption = createSvgElement("text", { x: 300, y: 323, class: "center-caption" });
  caption.textContent = count === 0 ? "予定を追加できます" : `この日の表示 ${formatDuration(visibleMinutes)}`;
  fragment.append(countText, caption);
}

function renderSchedule(segments) {
  const fragment = document.createDocumentFragment();
  const assigned = assignOverlapTracks(segments);
  appendScheduleBase(fragment);
  appendScheduleTapArea(fragment);
  appendEventSectors(fragment, assigned);
  appendHourMarks(fragment);
  appendCurrentTime(fragment);
  appendCenterSummary(fragment, segments);
  elements.scheduleLayer.replaceChildren(fragment);
}

function agendaTimeLabel(segment) {
  if (segment.continuesFromPrevious) {
    return `前日 ${segment.event.startTime}–${segment.event.endTime}`;
  }
  if (segment.continuesToNext) {
    return `${segment.event.startTime}–翌 ${segment.event.endTime}`;
  }
  return `${segment.event.startTime}–${segment.event.endTime}`;
}

function renderAgenda(segments) {
  const uniqueSegments = [];
  const seen = new Set();
  for (const segment of segments) {
    if (!seen.has(segment.event.id)) {
      seen.add(segment.event.id);
      uniqueSegments.push(segment);
    }
  }

  const fragment = document.createDocumentFragment();
  for (const segment of uniqueSegments) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "event-card";
    button.style.setProperty("--event-color", segment.event.color);
    button.setAttribute("aria-label", eventAriaLabel(segment.event));
    button.addEventListener("click", () => openEditDialog(segment.event.id));

    const stripe = document.createElement("span");
    stripe.className = "event-card__stripe";
    stripe.setAttribute("aria-hidden", "true");

    const content = document.createElement("span");
    content.className = "event-card__content";
    const time = document.createElement("span");
    time.className = "event-card__time";
    time.textContent = agendaTimeLabel(segment);
    const title = document.createElement("span");
    title.className = "event-card__title";
    title.textContent = segment.event.title;
    const category = document.createElement("span");
    category.className = "event-card__category";
    category.textContent = `${segment.event.category}・${formatDuration(eventDurationMinutes(segment.event))}`;
    content.append(time, title, category);

    const arrow = document.createElement("span");
    arrow.className = "event-card__arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";
    button.append(stripe, content, arrow);
    fragment.append(button);
  }

  elements.eventList.replaceChildren(fragment);
  elements.eventCount.textContent = `${uniqueSegments.length}件`;
  elements.emptyState.hidden = uniqueSegments.length !== 0;
}

function render() {
  elements.selectedDate.dateTime = selectedDate;
  elements.selectedDate.textContent = formatDate(selectedDate);
  elements.dateRelative.textContent = relativeDateLabel(selectedDate);
  const segments = getVisibleEventSegments(events, selectedDate);
  renderSchedule(segments);
  renderAgenda(segments);
}

function openDialog() {
  if (typeof elements.dialog.showModal === "function") {
    elements.dialog.showModal();
  } else {
    elements.dialog.setAttribute("open", "");
  }
  requestAnimationFrame(() => elements.title.focus());
}

function closeDialog() {
  if (typeof elements.dialog.close === "function" && elements.dialog.open) {
    elements.dialog.close();
  } else {
    elements.dialog.removeAttribute("open");
  }
}

function resetDialogState() {
  elements.formError.hidden = true;
  elements.formError.textContent = "";
  elements.deleteConfirmation.hidden = true;
}

function updateOvernightHint() {
  if (!elements.startTime.value || !elements.endTime.value) {
    elements.overnightHint.hidden = true;
    return;
  }
  elements.overnightHint.hidden =
    timeToMinutes(elements.endTime.value) >= timeToMinutes(elements.startTime.value);
}

function updatePalette() {
  for (const swatch of elements.palette.querySelectorAll("button[data-color]")) {
    swatch.setAttribute(
      "aria-pressed",
      String(swatch.dataset.color.toLowerCase() === elements.color.value.toLowerCase()),
    );
  }
}

function openNewDialog(initialTimeRange = null) {
  editingId = null;
  elements.form.reset();
  resetDialogState();
  elements.dialogTitle.textContent = "予定を追加";
  elements.eventDateNote.textContent = formatDate(selectedDate);
  elements.deleteButton.hidden = true;
  elements.category.value = "その他";
  elements.color.value = DEFAULT_COLOR;

  if (initialTimeRange) {
    elements.startTime.value = initialTimeRange.startTime;
    elements.endTime.value = initialTimeRange.endTime;
  } else {
    const now = new Date();
    const startMinutes =
      selectedDate === localDateString(now)
        ? Math.min(1425, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15)
        : 9 * 60;
    elements.startTime.value = minutesToClock(startMinutes);
    elements.endTime.value = minutesToClock(startMinutes + 60);
  }
  updateOvernightHint();
  updatePalette();
  openDialog();
}

function openEditDialog(id) {
  const event = events.find((item) => item.id === id);
  if (!event) return;

  editingId = id;
  resetDialogState();
  elements.dialogTitle.textContent = "予定を編集";
  elements.eventDateNote.textContent = `開始日 ${formatDate(event.date)}`;
  elements.title.value = event.title;
  elements.startTime.value = event.startTime;
  elements.endTime.value = event.endTime;
  elements.category.value = event.category;
  elements.color.value = event.color;
  elements.deleteButton.hidden = false;
  updateOvernightHint();
  updatePalette();
  openDialog();
}

function showFormError(message) {
  elements.formError.textContent = message;
  elements.formError.hidden = false;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function drawerFocusableElements() {
  return [...elements.menuDrawer.querySelectorAll("button:not(:disabled), a[href], input, select")]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function openMenu() {
  if (menuOpen) return;
  menuOpen = true;
  focusBeforeMenu = document.activeElement;
  elements.menuLayer.classList.add("is-open");
  elements.menuLayer.setAttribute("aria-hidden", "false");
  elements.menuDrawer.inert = false;
  elements.menuToggle.setAttribute("aria-expanded", "true");
  elements.menuToggle.setAttribute("aria-label", "メニューを閉じる");
  document.body.classList.add("menu-open");
  elements.menuClose.focus();
}

function closeMenu({ restoreFocus = true } = {}) {
  if (!menuOpen) return;
  menuOpen = false;
  elements.menuLayer.classList.remove("is-open");
  elements.menuLayer.setAttribute("aria-hidden", "true");
  elements.menuDrawer.inert = true;
  elements.menuToggle.setAttribute("aria-expanded", "false");
  elements.menuToggle.setAttribute("aria-label", "メニューを開く");
  document.body.classList.remove("menu-open");

  if (restoreFocus) {
    const focusTarget = focusBeforeMenu?.isConnected ? focusBeforeMenu : elements.menuToggle;
    focusTarget.focus();
  }
  focusBeforeMenu = null;
}

function trapMenuFocus(event) {
  if (!menuOpen || event.key !== "Tab") return;
  const focusable = drawerFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    return;
  }

  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function setUpdateStatus(message, state = "idle") {
  elements.updateStatus.textContent = message;
  elements.updateStatus.dataset.state = state;
}

function waitForWorkerActivation(worker, timeoutMs = 20_000) {
  if (worker.state === "activated") return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.removeEventListener("statechange", handleStateChange);
      reject(new Error("Service Worker activation timed out"));
    }, timeoutMs);

    function handleStateChange() {
      if (worker.state === "activated") {
        window.clearTimeout(timeout);
        worker.removeEventListener("statechange", handleStateChange);
        resolve();
      } else if (worker.state === "redundant") {
        window.clearTimeout(timeout);
        worker.removeEventListener("statechange", handleStateChange);
        reject(new Error("Service Worker became redundant"));
      }
    }

    worker.addEventListener("statechange", handleStateChange);
  });
}

function requestAppShellRefresh(worker, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const messageChannel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      messageChannel.port1.close();
      reject(new Error("App shell refresh timed out"));
    }, timeoutMs);

    messageChannel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      messageChannel.port1.close();
      if (event.data?.ok) {
        resolve(event.data);
      } else {
        reject(new Error("App shell refresh failed"));
      }
    };

    worker.postMessage({ type: "REFRESH_APP_SHELL" }, [messageChannel.port2]);
  });
}

async function updateApplication() {
  if (updateInProgress) return;
  updateInProgress = true;
  elements.updateApp.disabled = true;
  elements.updateApp.classList.add("is-updating");
  elements.updateApp.setAttribute("aria-busy", "true");
  setUpdateStatus("最新版を確認しています…");

  try {
    if (!navigator.onLine || !("serviceWorker" in navigator)) {
      throw new Error("Service Worker update is unavailable");
    }

    let registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      registration = await navigator.serviceWorker.register("./service-worker.js", {
        updateViaCache: "none",
      });
    }

    await registration.update();
    const pendingWorker = registration.installing || registration.waiting;
    const workerWasUpdated = Boolean(pendingWorker);
    if (pendingWorker) await waitForWorkerActivation(pendingWorker);

    const activeWorker = registration.active || navigator.serviceWorker.controller;
    if (!activeWorker) throw new Error("No active Service Worker");

    const result = await requestAppShellRefresh(activeWorker);
    const wasUpdated = workerWasUpdated || result.updated;
    setUpdateStatus(
      wasUpdated ? "アプリを更新しました。再読み込みします…" : "最新版です。再読み込みします…",
      "success",
    );
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    window.location.reload();
  } catch {
    setUpdateStatus("更新を確認できませんでした。通信状態を確認してください。", "error");
    elements.updateApp.disabled = false;
    elements.updateApp.classList.remove("is-updating");
    elements.updateApp.removeAttribute("aria-busy");
    updateInProgress = false;
  }
}

function saveEvent(event) {
  try {
    repository.upsert(event);
    events = repository.getAll();
    closeDialog();
    render();
    showToast(editingId ? "予定を更新しました。" : "予定を追加しました。");
  } catch {
    showFormError("予定を保存できませんでした。ブラウザの保存容量や設定を確認してください。");
  }
}

elements.form.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  const existing = editingId ? events.find((event) => event.id === editingId) : null;
  const event = {
    ...(existing || {}),
    id: editingId || createId(),
    date: existing?.date || selectedDate,
    title: elements.title.value.trim(),
    startTime: elements.startTime.value,
    endTime: elements.endTime.value,
    category: elements.category.value.trim(),
    color: elements.color.value.toLowerCase(),
    externalIds: existing?.externalIds || {},
  };
  const validationMessage = validateEventDraft(event);
  if (validationMessage) {
    showFormError(validationMessage);
    return;
  }
  saveEvent(event);
});

elements.menuToggle.addEventListener("click", () => (menuOpen ? closeMenu() : openMenu()));
elements.menuOverlay.addEventListener("click", () => closeMenu());
elements.menuClose.addEventListener("click", () => closeMenu());
elements.updateApp.addEventListener("click", updateApplication);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuOpen) {
    event.preventDefault();
    closeMenu();
    return;
  }
  trapMenuFocus(event);
});

elements.addButton.addEventListener("click", () => openNewDialog());
elements.emptyAddButton.addEventListener("click", () => openNewDialog());
elements.previousDay.addEventListener("click", () => {
  selectedDate = addDays(selectedDate, -1);
  render();
});
elements.today.addEventListener("click", () => {
  selectedDate = localDateString(new Date());
  render();
});
elements.nextDay.addEventListener("click", () => {
  selectedDate = addDays(selectedDate, 1);
  render();
});

elements.startTime.addEventListener("change", updateOvernightHint);
elements.endTime.addEventListener("change", updateOvernightHint);
elements.color.addEventListener("input", updatePalette);
elements.category.addEventListener("change", () => {
  if (!editingId && CATEGORY_COLORS.has(elements.category.value.trim())) {
    elements.color.value = CATEGORY_COLORS.get(elements.category.value.trim());
    updatePalette();
  }
});

elements.palette.addEventListener("click", (event) => {
  const swatch = event.target.closest("button[data-color]");
  if (!swatch) return;
  elements.color.value = swatch.dataset.color;
  updatePalette();
});

elements.deleteButton.addEventListener("click", () => {
  elements.deleteConfirmation.hidden = false;
  elements.deleteButton.hidden = true;
  elements.confirmDelete.focus();
});
elements.cancelDelete.addEventListener("click", () => {
  elements.deleteConfirmation.hidden = true;
  elements.deleteButton.hidden = false;
  elements.deleteButton.focus();
});
elements.confirmDelete.addEventListener("click", () => {
  if (!editingId) return;
  try {
    repository.remove(editingId);
    events = repository.getAll();
    closeDialog();
    render();
    showToast("予定を削除しました。");
  } catch {
    showFormError("予定を削除できませんでした。ブラウザの保存設定を確認してください。");
  }
});

elements.closeDialog.addEventListener("click", closeDialog);
elements.cancelDialog.addEventListener("click", closeDialog);
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) closeDialog();
});
elements.dialog.addEventListener("close", resetDialogState);

window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) {
    events = repository.load();
    render();
    showToast("別のタブで更新された予定を反映しました。");
  }
});

function updateConnectionStatus() {
  elements.connectionStatus.textContent = navigator.onLine
    ? "オンライン・オフライン利用準備済み"
    : "オフラインで利用中";
}

window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);
updateConnectionStatus();

if (repository.warning) {
  showToast(repository.warning);
}

render();
window.setInterval(() => {
  if (selectedDate === localDateString(new Date()) && !elements.dialog.open) render();
}, 60_000);
