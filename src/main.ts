import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// ── Constants ──────────────────────────────────────────────────────────────
const STUDY_PASSWORD = "12345";
const SCHEDULE_STORAGE_KEY = "study-mode-schedule";
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const appWindow = getCurrentWebviewWindow();

// ── Types ──────────────────────────────────────────────────────────────────
type PasswordMode =
  | "stop-study"
  | "delete-site"
  | "delete-block"
  | "dismiss-startup-5"
  | "dismiss-startup-10"
  | "dismiss-startup-immediate"
  | "dismiss-startup-schedule"
  | "stop-study-close";

interface ScheduleBlock {
  id: string;
  day: number; // 0 = Mon … 6 = Sun
  startMinutes: number;
  endMinutes: number;
}

interface ScheduleData {
  pausedUntil: string | null;
  blocks: ScheduleBlock[];
}

// ── DOM References ─────────────────────────────────────────────────────────
const startupOverlay = document.getElementById("startup-overlay")!;
const passwordOverlay = document.getElementById("password-overlay")!;
const blockedModalOverlay = document.getElementById("blocked-modal-overlay")!;
const scheduleModalOverlay = document.getElementById("schedule-modal-overlay")!;
const pauseScheduleOverlay = document.getElementById("pause-schedule-overlay")!;
const mainScreen = document.getElementById("main-screen")!;

const btnStartNow = document.getElementById("btn-start-now")!;
const btnStart5 = document.getElementById("btn-start-5")!;
const btnStart10 = document.getElementById("btn-start-10")!;
const linkSchedule = document.getElementById("link-schedule")!;

const statusBadge = document.getElementById("status-badge")!;
const modeStatusText = document.getElementById("mode-status-text")!;
const countdownBanner = document.getElementById("countdown-banner")!;
const countdownValue = document.getElementById("countdown-value")!;
const btnToggleStudy = document.getElementById("btn-toggle-study")!;
const websitesCard = document.querySelector(".websites-card")!;
const mainSitesList = document.getElementById("main-sites-list")!;

const passwordModalTitle = document.getElementById("password-modal-title")!;
const passwordModalSubtitle = document.getElementById("password-modal-subtitle")!;
const passwordInput = document.getElementById("password-input") as HTMLInputElement;
const passwordError = document.getElementById("password-error")!;
const btnPasswordCancel = document.getElementById("btn-password-cancel")!;
const btnPasswordConfirm = document.getElementById("btn-password-confirm")!;

const manageSitesList = document.getElementById("manage-sites-list")!;
const addSiteInput = document.getElementById("add-site-input") as HTMLInputElement;
const btnAddSite = document.getElementById("btn-add-site")!;
const btnBlockedModalClose = document.getElementById("btn-blocked-modal-close")!;

const scheduleCalendarGrid = document.getElementById("schedule-calendar-grid")!;
const scheduleToggleStatus = document.getElementById("schedule-toggle-status")!;
const btnPauseSchedule = document.getElementById("btn-pause-schedule")!;
const btnCancelPause = document.getElementById("btn-cancel-pause")!;
const btnScheduleModalClose = document.getElementById("btn-schedule-modal-close")!;
const addBlockDay = document.getElementById("add-block-day") as HTMLSelectElement;
const addBlockStart = document.getElementById("add-block-start") as HTMLInputElement;
const addBlockEnd = document.getElementById("add-block-end") as HTMLInputElement;
const btnAddBlock = document.getElementById("btn-add-block")!;
const addBlockError = document.getElementById("add-block-error")!;

const pausePasswordInput = document.getElementById("pause-password-input") as HTMLInputElement;
const pauseDaysInput = document.getElementById("pause-days-input") as HTMLInputElement;
const pauseScheduleError = document.getElementById("pause-schedule-error")!;
const btnPauseCancel = document.getElementById("btn-pause-cancel")!;
const btnPauseConfirm = document.getElementById("btn-pause-confirm")!;

const errorBanner = document.getElementById("error-banner")!;
const errorBannerText = document.getElementById("error-banner-text")!;
const btnErrorDismiss = document.getElementById("btn-error-dismiss")!;

// ── State ──────────────────────────────────────────────────────────────────
let studyModeActive = false;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownSeconds = 0;

let passwordMode: PasswordMode = "stop-study";
let pendingDeleteSite: string | null = null;
let pendingDeleteBlockId: string | null = null;

let schedulePausedUntil: string | null = null;
let scheduleBlocks: ScheduleBlock[] = [];
let scheduleManualStop = false;
let scheduleInterval: ReturnType<typeof setInterval> | null = null;
let studyModeFromSchedule = false;
let activeSchedulePromptBlockId: string | null = null;
let countdownFromSchedule = false;

let blockedSites: string[] = [
  "youtube.com / youtu.be",
  "instagram.com",
  "tiktok.com",
  "twitter.com / x.com",
  "reddit.com / redd.it",
];

// ── Error Banner ───────────────────────────────────────────────────────────
function showError(msg: string) {
  errorBannerText.textContent = msg;
  errorBanner.classList.remove("hidden");
}

btnErrorDismiss.addEventListener("click", () => errorBanner.classList.add("hidden"));

// ── Utilities ──────────────────────────────────────────────────────────────
function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(str: string): string {
  return str.replace(/"/g, "&quot;");
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function getMondayBasedDay(date: Date): number {
  const jsDay = date.getDay(); // 0 = Sun
  return jsDay === 0 ? 6 : jsDay - 1;
}

function getCurrentMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Schedule Persistence ───────────────────────────────────────────────────
function loadSchedule(): void {
  try {
    const raw = localStorage.getItem(SCHEDULE_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as ScheduleData & { enabled?: boolean };
    scheduleBlocks = Array.isArray(data.blocks) ? data.blocks : [];
    schedulePausedUntil = data.pausedUntil ?? null;
    clearExpiredPause();
  } catch {
    schedulePausedUntil = null;
    scheduleBlocks = [];
  }
}

function saveSchedule(): void {
  const data: ScheduleData = { pausedUntil: schedulePausedUntil, blocks: scheduleBlocks };
  localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(data));
}

function isSchedulePaused(now = new Date()): boolean {
  if (!schedulePausedUntil) return false;
  return now < new Date(schedulePausedUntil);
}

function clearExpiredPause(): void {
  if (schedulePausedUntil && !isSchedulePaused()) {
    schedulePausedUntil = null;
    saveSchedule();
    if (!scheduleModalOverlay.classList.contains("hidden")) {
      renderScheduleToggle();
    }
  }
}

function isScheduleActive(): boolean {
  clearExpiredPause();
  return !isSchedulePaused();
}

function formatMinutesCompact(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h >= 12 ? "p" : "a";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${m.toString().padStart(2, "0")}${period}`;
}

function formatPauseResumeDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function setPauseForDays(days: number): void {
  const resume = new Date();
  resume.setHours(0, 0, 0, 0);
  resume.setDate(resume.getDate() + days);
  schedulePausedUntil = resume.toISOString();
}

// ── Site List Rendering ────────────────────────────────────────────────────
function renderMainSitesList() {
  mainSitesList.innerHTML = blockedSites
    .map(
      (site) => `
      <li class="website-item">
        <span class="site-dot"></span>
        <span class="site-name">${escapeHtml(site)}</span>
      </li>`
    )
    .join("");
}

function renderManageSitesList() {
  manageSitesList.innerHTML = blockedSites
    .map(
      (site) => `
      <li class="manage-site-item">
        <span>${escapeHtml(site)}</span>
        <button class="btn-delete-site" data-site="${escapeAttr(site)}" title="Delete site">🗑</button>
      </li>`
    )
    .join("");

  manageSitesList.querySelectorAll<HTMLButtonElement>(".btn-delete-site").forEach((btn) => {
    btn.addEventListener("click", () => {
      const site = btn.getAttribute("data-site")!;
      openPasswordModal("delete-site", { site });
    });
  });
}

// ── Schedule Rendering ───────────────────────────────────────────────────────
function renderScheduleToggle() {
  clearExpiredPause();

  if (isSchedulePaused()) {
    scheduleToggleStatus.textContent = `Paused — resumes ${formatPauseResumeDate(schedulePausedUntil!)}`;
    btnPauseSchedule.classList.add("hidden");
    btnCancelPause.classList.remove("hidden");
  } else {
    scheduleToggleStatus.textContent = "On — Study Mode starts automatically";
    btnPauseSchedule.classList.remove("hidden");
    btnCancelPause.classList.add("hidden");
  }
}

function renderScheduleCalendar() {
  scheduleCalendarGrid.innerHTML = DAY_NAMES.map((dayName, dayIndex) => {
    const dayBlocks = scheduleBlocks
      .filter((b) => b.day === dayIndex)
      .sort((a, b) => a.startMinutes - b.startMinutes);

    const blocksHtml =
      dayBlocks.length === 0
        ? `<div class="schedule-day-empty">—</div>`
        : dayBlocks
            .map(
              (b) => `
          <div class="schedule-block-chip">
            <span class="schedule-block-time">${formatMinutesCompact(b.startMinutes)}–${formatMinutesCompact(b.endMinutes)}</span>
            <button class="btn-delete-block" data-block-id="${escapeAttr(b.id)}" title="Delete block">🗑</button>
          </div>`
            )
            .join("");

    return `
      <div class="schedule-day-column">
        <div class="schedule-day-header">${dayName}</div>
        <div class="schedule-day-blocks">${blocksHtml}</div>
      </div>`;
  }).join("");

  scheduleCalendarGrid.querySelectorAll<HTMLButtonElement>(".btn-delete-block").forEach((btn) => {
    btn.addEventListener("click", () => {
      const blockId = btn.getAttribute("data-block-id")!;
      openPasswordModal("delete-block", { blockId });
    });
  });
}

function getActiveScheduledBlock(now = new Date()): ScheduleBlock | null {
  const day = getMondayBasedDay(now);
  const minutes = getCurrentMinutes(now);
  return scheduleBlocks.find(
    (b) =>
      b.day === day &&
      minutes >= b.startMinutes &&
      minutes < b.endMinutes
  ) ?? null;
}

function isInScheduledBlock(now = new Date()): boolean {
  return getActiveScheduledBlock(now) !== null;
}

function tickSchedule() {
  if (!isScheduleActive()) return;

  const activeBlock = getActiveScheduledBlock();

  if (!activeBlock) {
    scheduleManualStop = false;
    activeSchedulePromptBlockId = null;
    if (studyModeActive && studyModeFromSchedule) deactivateStudyMode();
    return;
  }

  if (scheduleManualStop) return;

  if (!studyModeActive && activeSchedulePromptBlockId !== activeBlock.id) {
    showScheduledStartupPrompt(activeBlock.id);
  }
}

function startScheduleChecker() {
  if (scheduleInterval) clearInterval(scheduleInterval);
  tickSchedule();
  scheduleInterval = setInterval(tickSchedule, 30_000);
}

// ── Tauri / Blocking ───────────────────────────────────────────────────────
async function notifyRust(active: boolean) {
  try {
    await invoke("set_study_mode_active", { active });
  } catch (e) {
    console.error("Failed to notify Rust of study mode state:", e);
  }
}

async function applyHostsBlocking() {
  try {
    await invoke("block_sites", { sites: blockedSites });
    errorBanner.classList.add("hidden");
  } catch (e) {
    showError(`Site blocking failed. (${e})`);
  }
}

async function removeHostsBlocking() {
  try {
    await invoke("unblock_sites");
    errorBanner.classList.add("hidden");
  } catch (e) {
    showError(`Could not unblock sites: ${e}`);
  }
}

async function bringAppToFront() {
  try {
    await invoke("show_app_window");
  } catch (e) {
    console.error("Failed to bring app window to front:", e);
  }
}

// ── Study Mode Activation / Deactivation ──────────────────────────────────
function activateStudyMode(fromSchedule = false) {
  studyModeActive = true;
  studyModeFromSchedule = fromSchedule;
  clearPendingCountdown();

  statusBadge.textContent = "On";
  statusBadge.className = "status-badge status-on";
  modeStatusText.innerHTML = "Study Mode is <strong>on</strong>";
  btnToggleStudy.textContent = "Stop Study Mode";
  btnToggleStudy.className = "btn btn-stop btn-xl";
  websitesCard.classList.add("study-active");

  notifyRust(true);
  applyHostsBlocking();
}

function deactivateStudyMode() {
  studyModeActive = false;
  studyModeFromSchedule = false;
  clearPendingCountdown();

  statusBadge.textContent = "Off";
  statusBadge.className = "status-badge status-off";
  modeStatusText.innerHTML = "Study Mode is <strong>off</strong>";
  btnToggleStudy.textContent = "Start Study Mode";
  btnToggleStudy.className = "btn btn-start btn-xl";
  websitesCard.classList.remove("study-active");

  notifyRust(false);
  removeHostsBlocking();
}

// ── Countdown Logic ────────────────────────────────────────────────────────
function clearPendingCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  countdownBanner.classList.add("hidden");
  countdownSeconds = 0;

  if (!studyModeActive) {
    statusBadge.textContent = "Off";
    statusBadge.className = "status-badge status-off";
  }
}

function startCountdown(minutes: number, fromSchedule = false) {
  clearPendingCountdown();
  countdownFromSchedule = fromSchedule;
  countdownSeconds = minutes * 60;

  statusBadge.textContent = "Pending";
  statusBadge.className = "status-badge status-pending";
  countdownValue.textContent = formatCountdown(countdownSeconds);
  countdownBanner.classList.remove("hidden");

  countdownTimer = setInterval(() => {
    countdownSeconds -= 1;
    countdownValue.textContent = formatCountdown(countdownSeconds);
    if (countdownSeconds <= 0) {
      clearInterval(countdownTimer!);
      countdownTimer = null;
      if (!countdownFromSchedule || isInScheduledBlock()) {
        activateStudyMode(countdownFromSchedule);
      }
      countdownFromSchedule = false;
    }
  }, 1000);
}

// ── Startup Modal ──────────────────────────────────────────────────────────
function showMainScreen() {
  startupOverlay.classList.add("hidden");
  mainScreen.classList.remove("hidden");
}

function showScheduledStartupPrompt(blockId: string) {
  activeSchedulePromptBlockId = blockId;
  closeScheduleModal(true);
  closeBlockedModal();
  bringAppToFront();
  mainScreen.classList.remove("hidden");
  startupOverlay.classList.remove("hidden");
  notifyRust(true);
}

function dismissStartupModal(delayMinutes: number | "now" | "immediate") {
  showMainScreen();
  const fromSchedule = activeSchedulePromptBlockId !== null;

  if (delayMinutes === "now" || delayMinutes === "immediate") {
    activateStudyMode(fromSchedule);
  } else {
    startCountdown(delayMinutes as number, fromSchedule);
  }
}

btnStartNow.addEventListener("click", () => dismissStartupModal("now"));

btnStart5.addEventListener("click", () => {
  dismissStartupModal(5);
});

btnStart10.addEventListener("click", () => {
  dismissStartupModal(10);
});

startupOverlay.addEventListener("click", (e) => {
  if (e.target === startupOverlay) {
    if (activeSchedulePromptBlockId !== null) {
      openPasswordModal("dismiss-startup-immediate", {});
    } else {
      dismissStartupModal("immediate");
    }
  }
});

linkSchedule.addEventListener("click", (e) => {
  e.preventDefault();
  showMainScreen();
  openScheduleModal();
});

// ── Main Screen Toggle Button ──────────────────────────────────────────────
btnToggleStudy.addEventListener("click", () => {
  if (studyModeActive) {
    openPasswordModal("stop-study", {});
  } else {
    activateStudyMode(false);
  }
});

// ── Password Modal ─────────────────────────────────────────────────────────
type PasswordPayload = {
  site?: string;
  blockId?: string;
};

function openPasswordModal(mode: PasswordMode, payload: PasswordPayload) {
  passwordMode = mode;
  pendingDeleteSite = payload.site ?? null;
  pendingDeleteBlockId = payload.blockId ?? null;

  if (mode === "stop-study") {
    passwordModalTitle.textContent = "Stop Study Mode?";
    passwordModalSubtitle.textContent = "Enter your password to turn off Study Mode.";
    btnPasswordConfirm.textContent = "Stop Study Mode";
    btnPasswordConfirm.className = "btn btn-danger";
  } else if (mode === "delete-site") {
    passwordModalTitle.textContent = `Delete "${payload.site}"?`;
    passwordModalSubtitle.textContent = "Enter your password to remove this site.";
    btnPasswordConfirm.textContent = "Delete Site";
    btnPasswordConfirm.className = "btn btn-danger";
  } else if (mode === "delete-block") {
    passwordModalTitle.textContent = "Delete time block?";
    passwordModalSubtitle.textContent = "Enter your password to remove this block.";
    btnPasswordConfirm.textContent = "Delete Block";
    btnPasswordConfirm.className = "btn btn-danger";
  } else if (mode === "dismiss-startup-5" || mode === "dismiss-startup-10") {
    passwordModalTitle.textContent = "Delay Study Mode?";
    passwordModalSubtitle.textContent = "Enter your password to delay Study Mode.";
    btnPasswordConfirm.textContent = "Confirm Delay";
    btnPasswordConfirm.className = "btn btn-danger";
  } else if (mode === "dismiss-startup-immediate") {
    passwordModalTitle.textContent = "Stop Study Mode?";
    passwordModalSubtitle.textContent = "Enter your password to turn off Study Mode.";
    btnPasswordConfirm.textContent = "Stop Study Mode";
    btnPasswordConfirm.className = "btn btn-danger";
  } else if (mode === "dismiss-startup-schedule") {
    passwordModalTitle.textContent = "Open Schedule?";
    passwordModalSubtitle.textContent = "Enter your password to turn off Study Mode and open the schedule.";
    btnPasswordConfirm.textContent = "Open Schedule";
    btnPasswordConfirm.className = "btn btn-danger";
  } else if (mode === "stop-study-close") {
    passwordModalTitle.textContent = "Stop Study Mode?";
    passwordModalSubtitle.textContent = "Enter your password to turn off Study Mode and close the window.";
    btnPasswordConfirm.textContent = "Stop & Close";
    btnPasswordConfirm.className = "btn btn-danger";
  }

  passwordInput.value = "";
  passwordError.classList.add("hidden");
  passwordInput.classList.remove("input-error");
  passwordOverlay.classList.remove("hidden");
  setTimeout(() => passwordInput.focus(), 50);
}

function closePasswordModal() {
  passwordOverlay.classList.add("hidden");
  passwordInput.value = "";
  passwordError.classList.add("hidden");
  passwordInput.classList.remove("input-error");
  pendingDeleteSite = null;
  pendingDeleteBlockId = null;
}

btnPasswordCancel.addEventListener("click", closePasswordModal);

btnPasswordConfirm.addEventListener("click", () => {
  if (passwordInput.value === STUDY_PASSWORD) {
    const mode = passwordMode;
    const siteToDelete = pendingDeleteSite;
    const blockToDelete = pendingDeleteBlockId;
    closePasswordModal();

    if (mode === "stop-study") {
      if (isScheduleActive() && isInScheduledBlock()) {
        scheduleManualStop = true;
      }
      deactivateStudyMode();
    } else if (mode === "delete-site" && siteToDelete !== null) {
      blockedSites = blockedSites.filter((s) => s !== siteToDelete);
      renderMainSitesList();
      renderManageSitesList();
      if (studyModeActive) applyHostsBlocking();
    } else if (mode === "delete-block" && blockToDelete !== null) {
      scheduleBlocks = scheduleBlocks.filter((b) => b.id !== blockToDelete);
      saveSchedule();
      renderScheduleCalendar();
      tickSchedule();
    } else if (mode === "dismiss-startup-5") {
      if (isScheduleActive() && isInScheduledBlock()) {
        scheduleManualStop = true;
      }
      deactivateStudyMode();
      dismissStartupModal(5);
    } else if (mode === "dismiss-startup-10") {
      if (isScheduleActive() && isInScheduledBlock()) {
        scheduleManualStop = true;
      }
      deactivateStudyMode();
      dismissStartupModal(10);
    } else if (mode === "dismiss-startup-immediate") {
      if (isScheduleActive() && isInScheduledBlock()) {
        scheduleManualStop = true;
      }
      deactivateStudyMode();
      showMainScreen();
      appWindow.hide();
    } else if (mode === "dismiss-startup-schedule") {
      if (isScheduleActive() && isInScheduledBlock()) {
        scheduleManualStop = true;
      }
      deactivateStudyMode();
      showMainScreen();
      openScheduleModal();
    } else if (mode === "stop-study-close") {
      if (isScheduleActive() && isInScheduledBlock()) {
        scheduleManualStop = true;
      }
      deactivateStudyMode();
      appWindow.hide();
    }
  } else {
    passwordError.classList.remove("hidden");
    passwordInput.classList.add("input-error");
    passwordInput.value = "";
    passwordInput.focus();
  }
});

passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnPasswordConfirm.click();
  if (e.key === "Escape") closePasswordModal();
});

passwordOverlay.addEventListener("click", (e) => {
  if (e.target === passwordOverlay) closePasswordModal();
});

// ── Blocked Sites Modal ────────────────────────────────────────────────────
function openBlockedModal() {
  renderManageSitesList();
  addSiteInput.value = "";
  blockedModalOverlay.classList.remove("hidden");
  setTimeout(() => addSiteInput.focus(), 50);
}

function closeBlockedModal() {
  blockedModalOverlay.classList.add("hidden");
}

document.getElementById("btn-blocked")!.addEventListener("click", openBlockedModal);
btnBlockedModalClose.addEventListener("click", closeBlockedModal);

blockedModalOverlay.addEventListener("click", (e) => {
  if (e.target === blockedModalOverlay) closeBlockedModal();
});

function addSite() {
  const raw = addSiteInput.value.trim().toLowerCase();
  if (!raw) return;

  const site = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!site) return;

  if (blockedSites.includes(site)) {
    addSiteInput.select();
    return;
  }

  blockedSites.push(site);
  renderMainSitesList();
  renderManageSitesList();
  addSiteInput.value = "";
  addSiteInput.focus();
  if (studyModeActive) applyHostsBlocking();
}

btnAddSite.addEventListener("click", addSite);
addSiteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

// ── Weekly Schedule Modal ──────────────────────────────────────────────────
function openScheduleModal() {
  renderScheduleToggle();
  renderScheduleCalendar();
  addBlockError.classList.add("hidden");
  scheduleModalOverlay.classList.remove("hidden");
}

function closeScheduleModal(preventPromptReopen: boolean | unknown = false) {
  scheduleModalOverlay.classList.add("hidden");

  if (preventPromptReopen !== true && isScheduleActive() && isInScheduledBlock() && !studyModeActive && !scheduleManualStop) {
    const activeBlock = getActiveScheduledBlock();
    if (activeBlock) {
      showScheduledStartupPrompt(activeBlock.id);
    }
  }
}

document.getElementById("btn-scheduled")!.addEventListener("click", openScheduleModal);
btnScheduleModalClose.addEventListener("click", closeScheduleModal);

scheduleModalOverlay.addEventListener("click", (e) => {
  if (e.target === scheduleModalOverlay) closeScheduleModal();
});

function openPauseScheduleModal() {
  pausePasswordInput.value = "";
  pauseDaysInput.value = "7";
  pauseScheduleError.classList.add("hidden");
  pausePasswordInput.classList.remove("input-error");
  pauseScheduleOverlay.classList.remove("hidden");
  setTimeout(() => pausePasswordInput.focus(), 50);
}

function closePauseScheduleModal() {
  pauseScheduleOverlay.classList.add("hidden");
}

function cancelSchedulePause() {
  schedulePausedUntil = null;
  saveSchedule();
  renderScheduleToggle();
  tickSchedule();
}

btnPauseSchedule.addEventListener("click", openPauseScheduleModal);
btnCancelPause.addEventListener("click", cancelSchedulePause);
btnPauseCancel.addEventListener("click", closePauseScheduleModal);

pauseScheduleOverlay.addEventListener("click", (e) => {
  if (e.target === pauseScheduleOverlay) closePauseScheduleModal();
});

function applySchedulePause(days: number) {
  setPauseForDays(days);
  saveSchedule();
  if (studyModeActive && studyModeFromSchedule) deactivateStudyMode();
  renderScheduleToggle();
  tickSchedule();
}

btnPauseConfirm.addEventListener("click", () => {
  const days = Math.max(1, Math.min(365, Number(pauseDaysInput.value) || 1));
  pauseDaysInput.value = String(days);

  if (pausePasswordInput.value !== STUDY_PASSWORD) {
    pauseScheduleError.classList.remove("hidden");
    pausePasswordInput.classList.add("input-error");
    pausePasswordInput.value = "";
    pausePasswordInput.focus();
    return;
  }

  closePauseScheduleModal();
  applySchedulePause(days);
});

pausePasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnPauseConfirm.click();
  if (e.key === "Escape") closePauseScheduleModal();
});

function showAddBlockError(msg: string) {
  addBlockError.textContent = msg;
  addBlockError.classList.remove("hidden");
}

function addScheduleBlock() {
  addBlockError.classList.add("hidden");

  const day = Number(addBlockDay.value);
  const startMinutes = timeToMinutes(addBlockStart.value);
  const endMinutes = timeToMinutes(addBlockEnd.value);

  if (endMinutes <= startMinutes) {
    showAddBlockError("End time must be after start time.");
    return;
  }

  const overlaps = scheduleBlocks.some(
    (b) =>
      b.day === day &&
      startMinutes < b.endMinutes &&
      endMinutes > b.startMinutes
  );

  if (overlaps) {
    showAddBlockError("This block overlaps an existing block on that day.");
    return;
  }

  scheduleBlocks.push({
    id: generateId(),
    day,
    startMinutes,
    endMinutes,
  });

  saveSchedule();
  renderScheduleCalendar();
  tickSchedule();
}

btnAddBlock.addEventListener("click", addScheduleBlock);

// ── Window Close Interception ──────────────────────────────────────────────
appWindow.onCloseRequested(async (event) => {
  if (studyModeActive || activeSchedulePromptBlockId !== null) {
    event.preventDefault();
    if (activeSchedulePromptBlockId !== null) {
      openPasswordModal("dismiss-startup-immediate", {});
    } else {
      openPasswordModal("stop-study-close", {});
    }
  }
});

// ── Init ───────────────────────────────────────────────────────────────────
loadSchedule();
renderMainSitesList();
startScheduleChecker();

// ── Clock Button ───────────────────────────────────────────────────────────
document.getElementById("btn-clock")?.addEventListener("click", async () => {
  try {
    await invoke("open_clock_window");
  } catch (e) {
    showError(`Could not open clock: ${e}`);
  }
});
