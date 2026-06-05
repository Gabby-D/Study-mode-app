import { invoke } from "@tauri-apps/api/core";

// ── Constants ──────────────────────────────────────────────────────────────
const STUDY_PASSWORD = "12345";

// ── DOM References ─────────────────────────────────────────────────────────
const startupOverlay   = document.getElementById("startup-overlay")!;
const passwordOverlay  = document.getElementById("password-overlay")!;
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

const passwordInput    = document.getElementById("password-input") as HTMLInputElement;
const passwordError    = document.getElementById("password-error")!;
const btnPasswordCancel  = document.getElementById("btn-password-cancel")!;
const btnPasswordConfirm = document.getElementById("btn-password-confirm")!;

// ── State ──────────────────────────────────────────────────────────────────
let studyModeActive = false;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownSeconds = 0;

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

// ── Study Mode Activation / Deactivation ──────────────────────────────────
function activateStudyMode() {
  studyModeActive = true;
  clearPendingCountdown();

  // Update status badge
  statusBadge.textContent = "On";
  statusBadge.className = "status-badge status-on";

  // Update status text
  modeStatusText.innerHTML = "Study Mode is <strong>on</strong>";

  // Toggle button → Stop
  btnToggleStudy.textContent = "Stop Study Mode";
  btnToggleStudy.className = "btn btn-stop btn-xl";

  // Highlight blocked sites
  websitesCard.classList.add("study-active");

  // Tell Rust to block window close
  notifyRust(true);
}

function deactivateStudyMode() {
  studyModeActive = false;
  clearPendingCountdown();

  // Update status badge
  statusBadge.textContent = "Off";
  statusBadge.className = "status-badge status-off";

  // Update status text
  modeStatusText.innerHTML = "Study Mode is <strong>off</strong>";

  // Toggle button → Start
  btnToggleStudy.textContent = "Start Study Mode";
  btnToggleStudy.className = "btn btn-start btn-xl";

  // Un-highlight blocked sites
  websitesCard.classList.remove("study-active");

  // Tell Rust window close is allowed again
  notifyRust(false);
}

// ── Countdown Logic ────────────────────────────────────────────────────────
function clearPendingCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  countdownBanner.classList.add("hidden");
  countdownSeconds = 0;

  // Restore badge if it was "pending"
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

// Closing the startup modal (clicking backdrop) → immediate start
startupOverlay.addEventListener("click", (e) => {
  if (e.target === startupOverlay) dismissStartupModal("immediate");
});

// Schedule link does nothing in Phase 1
linkSchedule.addEventListener("click", (e) => e.preventDefault());

// ── Main Screen Toggle Button ──────────────────────────────────────────────
btnToggleStudy.addEventListener("click", () => {
  if (studyModeActive) {
    // Show password modal
    passwordInput.value = "";
    passwordError.classList.add("hidden");
    passwordInput.classList.remove("input-error");
    passwordOverlay.classList.remove("hidden");
    setTimeout(() => passwordInput.focus(), 50);
  } else {
    activateStudyMode();
  }
});

// ── Password Modal ─────────────────────────────────────────────────────────
function closePasswordModal() {
  passwordOverlay.classList.add("hidden");
  passwordInput.value = "";
  passwordError.classList.add("hidden");
  passwordInput.classList.remove("input-error");
}

btnPasswordCancel.addEventListener("click", closePasswordModal);

btnPasswordConfirm.addEventListener("click", () => {
  if (passwordInput.value === STUDY_PASSWORD) {
    closePasswordModal();
    deactivateStudyMode();
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

// Allow clicking the backdrop to close the password modal
passwordOverlay.addEventListener("click", (e) => {
  if (e.target === passwordOverlay) closePasswordModal();
});

// ── Secondary buttons (non-functional in Phase 1) ─────────────────────────
document.getElementById("btn-clock")?.addEventListener("click", () => {});
document.getElementById("btn-scheduled")?.addEventListener("click", () => {});
document.getElementById("btn-blocked")?.addEventListener("click", () => {});
