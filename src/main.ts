import { invoke } from "@tauri-apps/api/core";

// ── Constants ──────────────────────────────────────────────────────────────
const STUDY_PASSWORD = "12345";

// ── DOM References ─────────────────────────────────────────────────────────
const startupOverlay   = document.getElementById("startup-overlay")!;
const passwordOverlay  = document.getElementById("password-overlay")!;
const blockedModalOverlay = document.getElementById("blocked-modal-overlay")!;
const mainScreen       = document.getElementById("main-screen")!;

const btnStartNow      = document.getElementById("btn-start-now")!;
const btnStart5        = document.getElementById("btn-start-5")!;
const btnStart10       = document.getElementById("btn-start-10")!;
const linkSchedule     = document.getElementById("link-schedule")!;

const statusBadge      = document.getElementById("status-badge")!;
const modeStatusText   = document.getElementById("mode-status-text")!;
const countdownBanner  = document.getElementById("countdown-banner")!;
const countdownValue   = document.getElementById("countdown-value")!;
const btnToggleStudy   = document.getElementById("btn-toggle-study")!;
const websitesCard     = document.querySelector(".websites-card")!;
const mainSitesList    = document.getElementById("main-sites-list")!;

const passwordModalTitle    = document.getElementById("password-modal-title")!;
const passwordModalSubtitle = document.getElementById("password-modal-subtitle")!;
const passwordInput    = document.getElementById("password-input") as HTMLInputElement;
const passwordError    = document.getElementById("password-error")!;
const btnPasswordCancel  = document.getElementById("btn-password-cancel")!;
const btnPasswordConfirm = document.getElementById("btn-password-confirm")!;

const manageSitesList  = document.getElementById("manage-sites-list")!;
const addSiteInput     = document.getElementById("add-site-input") as HTMLInputElement;
const btnAddSite       = document.getElementById("btn-add-site")!;
const btnBlockedModalClose = document.getElementById("btn-blocked-modal-close")!;

const errorBanner      = document.getElementById("error-banner")!;
const errorBannerText  = document.getElementById("error-banner-text")!;
const btnErrorDismiss  = document.getElementById("btn-error-dismiss")!;

// ── State ──────────────────────────────────────────────────────────────────
let studyModeActive = false;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownSeconds = 0;

// Password modal mode: what happens on correct password
type PasswordMode = "stop-study" | "delete-site";
let passwordMode: PasswordMode = "stop-study";
let pendingDeleteSite: string | null = null;

// Blocked sites list (source of truth)
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

  // Attach delete listeners
  manageSitesList.querySelectorAll<HTMLButtonElement>(".btn-delete-site").forEach((btn) => {
    btn.addEventListener("click", () => {
      const site = btn.getAttribute("data-site")!;
      openPasswordModal("delete-site", site);
    });
  });
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(str: string): string {
  return str.replace(/"/g, "&quot;");
}

// Initial render
renderMainSitesList();

// ── Helpers ────────────────────────────────────────────────────────────────
function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
    showError(`Site blocking requires admin rights. Right-click the app and choose "Run as administrator". (${e})`);
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

// ── Study Mode Activation / Deactivation ──────────────────────────────────
function activateStudyMode() {
  studyModeActive = true;
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

function startCountdown(minutes: number) {
  clearPendingCountdown();
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
      activateStudyMode();
    }
  }, 1000);
}

// ── Startup Modal ──────────────────────────────────────────────────────────
function dismissStartupModal(delayMinutes: number | "now" | "immediate") {
  startupOverlay.classList.add("hidden");
  mainScreen.classList.remove("hidden");

  if (delayMinutes === "now" || delayMinutes === "immediate") {
    activateStudyMode();
  } else {
    startCountdown(delayMinutes as number);
  }
}

btnStartNow.addEventListener("click", () => dismissStartupModal("now"));
btnStart5.addEventListener("click",   () => dismissStartupModal(5));
btnStart10.addEventListener("click",  () => dismissStartupModal(10));

startupOverlay.addEventListener("click", (e) => {
  if (e.target === startupOverlay) dismissStartupModal("immediate");
});

linkSchedule.addEventListener("click", (e) => e.preventDefault());

// ── Main Screen Toggle Button ──────────────────────────────────────────────
btnToggleStudy.addEventListener("click", () => {
  if (studyModeActive) {
    openPasswordModal("stop-study", null);
  } else {
    activateStudyMode();
  }
});

// ── Password Modal ─────────────────────────────────────────────────────────
function openPasswordModal(mode: PasswordMode, site: string | null) {
  passwordMode = mode;
  pendingDeleteSite = site;

  if (mode === "stop-study") {
    passwordModalTitle.textContent = "Stop Study Mode?";
    passwordModalSubtitle.textContent = "Enter your password to turn off Study Mode.";
    btnPasswordConfirm.textContent = "Stop Study Mode";
  } else {
    passwordModalTitle.textContent = `Delete "${site}"?`;
    passwordModalSubtitle.textContent = "Enter your password to remove this site.";
    btnPasswordConfirm.textContent = "Delete Site";
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
}

btnPasswordCancel.addEventListener("click", closePasswordModal);

btnPasswordConfirm.addEventListener("click", () => {
  if (passwordInput.value === STUDY_PASSWORD) {
    const mode = passwordMode;
    const siteToDelete = pendingDeleteSite;
    closePasswordModal();
    if (mode === "stop-study") {
      deactivateStudyMode();
    } else if (mode === "delete-site" && siteToDelete !== null) {
      blockedSites = blockedSites.filter((s) => s !== siteToDelete);
      renderMainSitesList();
      renderManageSitesList();
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

  // Strip protocol if pasted
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
}

btnAddSite.addEventListener("click", addSite);
addSiteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

// ── Non-functional buttons ─────────────────────────────────────────────────
document.getElementById("btn-clock")?.addEventListener("click", () => {});
document.getElementById("btn-scheduled")?.addEventListener("click", () => {});
