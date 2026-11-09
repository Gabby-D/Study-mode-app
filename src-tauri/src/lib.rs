use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, UserAttentionType, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

const WINDOW_LABEL: &str = "main";
const HOSTS_PATH: &str = r"C:\Windows\System32\drivers\etc\hosts";
const MARKER_BEGIN: &str = "# --- Study Mode BEGIN ---";
const MARKER_END: &str = "# --- Study Mode END ---";
const DEFAULT_BLOCKED_SITES: &[&str] = &[
    "youtube.com / youtu.be",
    "instagram.com",
    "tiktok.com",
    "twitter.com / x.com",
    "reddit.com / redd.it",
];
const NONE_GIT_DATA_DIR: &str = r"G:\My Drive\none_git_files\Study-mode-app";

struct AppState {
    study_mode_active: Mutex<bool>,
    blocked_sites: Arc<Mutex<Vec<String>>>,
    schedule: Mutex<ScheduleRuntime>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleBlock {
    id: String,
    day: u8,
    start_minutes: u16,
    end_minutes: u16,
}

struct ScheduleRuntime {
    paused_until_ms: Option<i64>,
    blocks: Vec<ScheduleBlock>,
    manual_stop: bool,
    study_from_schedule: bool,
    /// User already chose Start, a delay, or a password dismiss for this block.
    resolved_block_id: Option<String>,
    /// Frontend has painted the chooser for this block, so we can stop re-emitting.
    prompt_shown_for: Option<String>,
    /// Keep the process and window up until they pick an option.
    prompt_locking: bool,
    countdown_deadline_ms: Option<i64>,
    countdown_from_schedule: bool,
    /// Delay already elapsed; keep waking the window until Study Mode turns on.
    countdown_pending_activation: bool,
}

impl Default for ScheduleRuntime {
    fn default() -> Self {
        Self {
            paused_until_ms: None,
            blocks: Vec::new(),
            manual_stop: false,
            study_from_schedule: false,
            resolved_block_id: None,
            prompt_shown_for: None,
            prompt_locking: false,
            countdown_deadline_ms: None,
            countdown_from_schedule: false,
            countdown_pending_activation: false,
        }
    }
}

#[link(name = "wininet")]
extern "system" {
    fn InternetSetOptionW(
        h_internet: *mut std::ffi::c_void,
        dw_option: u32,
        lp_buffer: *mut std::ffi::c_void,
        dw_buffer_length: u32,
    ) -> i32;
}

// ── Legacy Hosts Cleanup ───────────────────────────────────────────────────

fn normalize_hostname(h: &str) -> String {
    if h.starts_with("www.") {
        h[4..].to_string()
    } else {
        h.to_string()
    }
}

fn parse_hostnames(site: &str) -> Vec<String> {
    let mut hostnames = Vec::new();
    for part in site.split('/') {
        let part_trimmed = part.trim().to_lowercase();
        if !part_trimmed.is_empty() && part_trimmed.contains('.') {
            let base = normalize_hostname(&part_trimmed);
            
            // Add base variants
            hostnames.push(base.clone());
            hostnames.push(format!("www.{}", base));
            hostnames.push(format!("m.{}", base));
            
            // Add associated CDN/media domains to stop active streams instantly
            if base.contains("youtube") || base.contains("youtu.be") {
                hostnames.push("googlevideo.com".to_string());
                hostnames.push("www.googlevideo.com".to_string());
                hostnames.push("ytimg.com".to_string());
                hostnames.push("youtube-nocookie.com".to_string());
            } else if base.contains("instagram") {
                hostnames.push("cdninstagram.com".to_string());
                hostnames.push("www.cdninstagram.com".to_string());
            } else if base.contains("tiktok") {
                hostnames.push("byteoversea.com".to_string());
                hostnames.push("ibyteimg.com".to_string());
                hostnames.push("tiktokcdn.com".to_string());
            } else if base.contains("reddit") {
                hostnames.push("redditmedia.com".to_string());
                hostnames.push("redditstatic.com".to_string());
            } else if base.contains("twitter") || base.contains("x.com") {
                hostnames.push("twimg.com".to_string());
            }
        }
    }
    hostnames
}

fn remove_study_mode_entries(content: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    let mut in_block = false;

    for line in content.lines() {
        if line.trim() == MARKER_BEGIN {
            in_block = true;
            continue;
        }
        if line.trim() == MARKER_END {
            in_block = false;
            continue;
        }
        if !in_block {
            lines.push(line);
        }
    }

    let text = lines.join("\n");
    let text = text.trim_end().to_string();
    if text.is_empty() { text } else { text + "\n" }
}

fn flush_dns() {
    let _ = std::process::Command::new("ipconfig")
        .arg("/flushdns")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
}

fn cleanup_hosts_on_startup() {
    let hosts_path = Path::new(HOSTS_PATH);
    if let Ok(content) = fs::read_to_string(hosts_path) {
        if content.contains(MARKER_BEGIN) {
            let cleaned = remove_study_mode_entries(&content);
            if fs::write(hosts_path, cleaned).is_ok() {
                flush_dns();
            }
        }
    }
}

// ── Global Proxy Cleanup ───────────────────────────────────────────────────

fn cleanup_proxy_on_startup() {
    let _ = std::process::Command::new("reg")
        .args(&[
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "AutoConfigURL",
            "/f",
        ])
        .creation_flags(0x08000000)
        .output();

    unsafe {
        InternetSetOptionW(std::ptr::null_mut(), 39, std::ptr::null_mut(), 0);
        InternetSetOptionW(std::ptr::null_mut(), 37, std::ptr::null_mut(), 0);
    }
}

// ── PAC Server ─────────────────────────────────────────────────────────────

fn generate_pac_content(sites: &[String]) -> String {
    let mut conditions = Vec::new();
    for site in sites {
        for hostname in parse_hostnames(site) {
            conditions.push(format!("shExpMatch(host_lower, \"*{}\")", hostname));
            conditions.push(format!("shExpMatch(host_lower, \"{}\")", hostname));
        }
    }

    let conditions_str = if conditions.is_empty() {
        "false".to_string()
    } else {
        conditions.join(" || ")
    };

    format!(
        "function FindProxyForURL(url, host) {{\n\
         \tvar host_lower = host.toLowerCase();\n\
         \tif ({}) {{\n\
         \t\treturn \"PROXY 127.0.0.1:9999\";\n\
         \t}}\n\
         \treturn \"DIRECT\";\n\
         }}",
        conditions_str
    )
}

fn start_pac_server(blocked_sites: Arc<Mutex<Vec<String>>>) {
    thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:9998") {
            Ok(l) => l,
            Err(_) => return,
        };

        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };

            let blocked_sites = blocked_sites.clone();
            thread::spawn(move || {
                let mut buffer = [0; 1024];
                if stream.read(&mut buffer).is_err() {
                    return;
                }

                let request = String::from_utf8_lossy(&buffer);
                if request.starts_with("GET /proxy.pac") {
                    let sites = blocked_sites.lock().unwrap().clone();
                    let pac_content = generate_pac_content(&sites);

                    let response = format!(
                        "HTTP/1.1 200 OK\r\n\
                         Content-Type: application/x-ns-proxy-autoconfig\r\n\
                         Content-Length: {}\r\n\
                         Cache-Control: no-cache, no-store, must-revalidate\r\n\
                         Pragma: no-cache\r\n\
                         Expires: 0\r\n\
                         Connection: close\r\n\r\n\
                         {}",
                        pac_content.len(),
                        pac_content
                    );

                    let _ = stream.write_all(response.as_bytes());
                } else {
                    let response = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(response.as_bytes());
                }
                let _ = stream.flush();
            });
        }
    });
}

// ── Block Proxy Server ─────────────────────────────────────────────────────

fn start_block_proxy() {
    thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:9999") {
            Ok(l) => l,
            Err(_) => return,
        };

        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };

            thread::spawn(move || {
                let mut buffer = [0; 1024];
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(2)));

                if let Ok(n) = stream.read(&mut buffer) {
                    if n > 0 {
                        let request = String::from_utf8_lossy(&buffer[..n]);
                        if request.starts_with("CONNECT") {
                            // HTTPS Tunnel request - reject with 403 Forbidden to block instantly
                            let response = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n";
                            let _ = stream.write_all(response.as_bytes());
                        } else if request.starts_with("GET") || request.starts_with("POST") {
                            // HTTP request - return a nice HTML block page
                            let html = "<html><head><title>Blocked</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f8f9ff;color:#1e1b2e;}h1{color:#6c63ff;}p{color:#6b7280;}</style></head><body><h1>Study Mode Active</h1><p>This website is blocked because Study Mode is on. Stay focused!</p></body></html>";
                            let response = format!(
                                "HTTP/1.1 200 OK\r\n\
                                 Content-Type: text/html; charset=utf-8\r\n\
                                 Content-Length: {}\r\n\
                                 Connection: close\r\n\r\n\
                                 {}",
                                html.len(),
                                html
                            );
                            let _ = stream.write_all(response.as_bytes());
                        }
                    }
                }
                let _ = stream.flush();
            });
        }
    });
}

// ── Tauri Commands ─────────────────────────────────────────────────────────

fn enable_proxy_setting() -> Result<(), String> {
    let output = std::process::Command::new("reg")
        .args(&[
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "AutoConfigURL",
            "/t",
            "REG_SZ",
            "/d",
            "http://127.0.0.1:9998/proxy.pac",
            "/f",
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("Failed to run reg.exe: {e}"))?;

    if !output.status.success() {
        return Err("Failed to update registry proxy settings".to_string());
    }

    unsafe {
        InternetSetOptionW(std::ptr::null_mut(), 39, std::ptr::null_mut(), 0);
        InternetSetOptionW(std::ptr::null_mut(), 37, std::ptr::null_mut(), 0);
    }

    Ok(())
}

fn disable_proxy_setting() {
    let _ = std::process::Command::new("reg")
        .args(&[
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "AutoConfigURL",
            "/f",
        ])
        .creation_flags(0x08000000)
        .output();

    unsafe {
        InternetSetOptionW(std::ptr::null_mut(), 39, std::ptr::null_mut(), 0);
        InternetSetOptionW(std::ptr::null_mut(), 37, std::ptr::null_mut(), 0);
    }
}

fn none_git_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("STUDY_MODE_DATA_DIR") {
        let path = PathBuf::from(dir.trim());
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    PathBuf::from(NONE_GIT_DATA_DIR)
}

fn load_email_env() {
    let data_dir = none_git_data_dir();
    let mut candidates = vec![
        data_dir.join(".env"),
        data_dir.join(".env.txt"),
        PathBuf::from(".env"),
        PathBuf::from("../.env"),
        PathBuf::from("../../.env"),
        PathBuf::from("../../../.env"),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(".env"));
        }
    }

    for path in candidates {
        if path.is_file() && dotenvy::from_filename(&path).is_ok() {
            return;
        }
    }
}

fn read_env_var(names: &[&str], missing_message: &str) -> Result<String, String> {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            let cleaned = value.trim().to_string();
            if !cleaned.is_empty() {
                return Ok(cleaned);
            }
        }
    }

    Err(missing_message.to_string())
}

#[tauri::command]
fn open_clock_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("clock") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "clock",
        tauri::WebviewUrl::App("clock.html".into()),
    )
    .title("Focus Timer")
    .inner_size(360.0, 430.0)
    .min_inner_size(300.0, 340.0)
    .resizable(true)
    .always_on_top(true)
    .decorations(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn send_password_changed_email(new_password: String) -> Result<(), String> {
    load_email_env();

    let smtp_username = read_env_var(
        &["STUDY_MODE_SMTP_USERNAME"],
        "Email setup is missing. Add STUDY_MODE_SMTP_USERNAME to G:\\My Drive\\none_git_files\\Study-mode-app\\.env",
    )?;
    let smtp_password = read_env_var(
        &["STUDY_MODE_SMTP_APP_PASSWORD", "STUDY_MODE_SMTP_APP_PASSWORRD"],
        "Email setup is missing. Add STUDY_MODE_SMTP_APP_PASSWORD to G:\\My Drive\\none_git_files\\Study-mode-app\\.env",
    )?
    .replace(' ', "");
    let smtp_server = std::env::var("STUDY_MODE_SMTP_SERVER")
        .unwrap_or_else(|_| "smtp.gmail.com".to_string());
    let from_address = std::env::var("STUDY_MODE_SMTP_FROM")
        .map(|value| value.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty() && !value.starts_with("your-"))
        .unwrap_or_else(|| smtp_username.clone());

    let email = Message::builder()
        .from(from_address.parse().map_err(|e| format!("Invalid sender email: {e}"))?)
        .to("gabrielle.dar@gmail.com".parse().map_err(|e| format!("Invalid recipient email: {e}"))?)
        .subject("Study Mode password changed")
        .body(format!(
            "The Study Mode password was changed.\n\nNew password: {new_password}\n\nIf you did not make this change, open the Study Mode app and change the password again."
        ))
        .map_err(|e| format!("Failed to build email: {e}"))?;

    let creds = Credentials::new(smtp_username, smtp_password);
    let mailer = SmtpTransport::relay(&smtp_server)
        .map_err(|e| format!("Failed to connect to SMTP server: {e}"))?
        .credentials(creds)
        .build();

    mailer
        .send(&email)
        .map_err(|e| format!("Failed to send password email: {e}"))?;

    Ok(())
}

#[tauri::command]
fn set_study_mode_active(state: tauri::State<'_, AppState>, active: bool) {
    let mut guard = state.study_mode_active.lock().unwrap();
    *guard = active;
}

#[tauri::command]
fn show_app_window(app: tauri::AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
fn block_sites(state: tauri::State<'_, AppState>, sites: Vec<String>) -> Result<(), String> {
    // 1. Update the shared blocked sites list so the PAC server serves the updated list
    {
        let mut guard = state.blocked_sites.lock().unwrap();
        *guard = sites;
    }

    enable_proxy_setting()
}

#[tauri::command]
fn unblock_sites() -> Result<(), String> {
    disable_proxy_setting();
    Ok(())
}

#[tauri::command]
fn pause_study_mode_for_break(state: tauri::State<'_, AppState>) {
    let mut active = state.study_mode_active.lock().unwrap();
    *active = false;
    disable_proxy_setting();
}

#[tauri::command]
fn resume_study_mode_after_break(state: tauri::State<'_, AppState>) -> Result<(), String> {
    {
        let mut active = state.study_mode_active.lock().unwrap();
        *active = true;
    }

    {
        let mut sites = state.blocked_sites.lock().unwrap();
        if sites.is_empty() {
            *sites = DEFAULT_BLOCKED_SITES.iter().map(|site| site.to_string()).collect();
        }
    }

    enable_proxy_setting()
}

// ── Schedule Watcher ───────────────────────────────────────────────────────
// The chooser used to live in a webview timer. On Windows that timer is
// suspended while the window is hidden, and closing the window used to exit
// the process, so a block could start with nobody watching the clock.

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn local_day_and_minutes() -> (u8, u16) {
    #[repr(C)]
    struct WinSystemTime {
        _year: u16,
        _month: u16,
        day_of_week: u16,
        _day: u16,
        hour: u16,
        minute: u16,
        _second: u16,
        _milliseconds: u16,
    }

    extern "system" {
        fn GetLocalTime(out: *mut WinSystemTime);
    }

    unsafe {
        let mut st = std::mem::zeroed();
        GetLocalTime(&mut st);
        // Match the UI: 0 = Monday … 6 = Sunday.
        let day = if st.day_of_week == 0 {
            6
        } else {
            st.day_of_week as u8 - 1
        };
        (day, st.hour * 60 + st.minute)
    }
}

fn active_block(blocks: &[ScheduleBlock], day: u8, minutes: u16) -> Option<&ScheduleBlock> {
    blocks.iter().find(|block| {
        block.day == day && minutes >= block.start_minutes && minutes < block.end_minutes
    })
}

fn is_paused(schedule: &ScheduleRuntime, now: i64) -> bool {
    schedule
        .paused_until_ms
        .is_some_and(|until| now < until)
}

fn prompt_is_locking(app: &tauri::AppHandle) -> bool {
    app.state::<AppState>()
        .schedule
        .lock()
        .map(|schedule| schedule.prompt_locking)
        .unwrap_or(false)
}

#[cfg(windows)]
fn raise_hwnd(hwnd: *mut std::ffi::c_void) {
    #[link(name = "user32")]
    extern "system" {
        fn SetForegroundWindow(hwnd: *mut std::ffi::c_void) -> i32;
        fn SetWindowPos(
            hwnd: *mut std::ffi::c_void,
            insert_after: *mut std::ffi::c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn ShowWindow(hwnd: *mut std::ffi::c_void, cmd: i32) -> i32;
        fn BringWindowToTop(hwnd: *mut std::ffi::c_void) -> i32;
    }

    const SW_RESTORE: i32 = 9;
    const HWND_TOPMOST: isize = -1;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_SHOWWINDOW: u32 = 0x0040;

    unsafe {
        ShowWindow(hwnd, SW_RESTORE);
        SetWindowPos(
            hwnd,
            HWND_TOPMOST as *mut std::ffi::c_void,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
    }
}

fn force_show_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_always_on_top(true);
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        raise_hwnd(hwnd.0);
    }
    let _ = window.set_focus();
    let _ = window.request_user_attention(Some(UserAttentionType::Critical));
}

fn clear_window_topmost(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.set_always_on_top(false);
    }
}

#[tauri::command]
fn sync_schedule(
    state: tauri::State<'_, AppState>,
    paused_until_ms: Option<i64>,
    blocks: Vec<ScheduleBlock>,
    manual_stop: bool,
    study_from_schedule: bool,
) {
    let mut schedule = state.schedule.lock().unwrap();
    schedule.paused_until_ms = paused_until_ms;
    schedule.blocks = blocks;
    schedule.manual_stop = manual_stop;
    schedule.study_from_schedule = study_from_schedule;
}

#[tauri::command]
fn claim_schedule_prompt(state: tauri::State<'_, AppState>, block_id: String) -> bool {
    let mut schedule = state.schedule.lock().unwrap();
    let dismissed = schedule.manual_stop
        || schedule.resolved_block_id.as_ref() == Some(&block_id)
        || schedule.countdown_deadline_ms.is_some()
        || schedule.countdown_pending_activation;
    if dismissed {
        return false;
    }

    let study_active = *state.study_mode_active.lock().unwrap();
    if study_active {
        return false;
    }

    schedule.prompt_shown_for = Some(block_id);
    schedule.prompt_locking = true;
    true
}

#[tauri::command]
fn resolve_schedule_prompt(app: tauri::AppHandle, state: tauri::State<'_, AppState>, block_id: String) {
    {
        let mut schedule = state.schedule.lock().unwrap();
        schedule.resolved_block_id = Some(block_id);
        schedule.prompt_locking = false;
    }
    clear_window_topmost(&app);
}

#[tauri::command]
fn set_schedule_countdown(
    state: tauri::State<'_, AppState>,
    deadline_ms: Option<i64>,
    from_schedule: bool,
) {
    let mut schedule = state.schedule.lock().unwrap();
    schedule.countdown_deadline_ms = deadline_ms;
    schedule.countdown_from_schedule = from_schedule;
    if deadline_ms.is_some() {
        schedule.countdown_pending_activation = false;
    }
}

#[tauri::command]
fn raise_for_schedule(app: tauri::AppHandle) {
    force_show_main_window(&app);
}

fn end_scheduled_session(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let should_stop_blocking = {
        let mut schedule = state.schedule.lock().unwrap();
        let from_schedule = schedule.study_from_schedule;
        schedule.manual_stop = false;
        schedule.study_from_schedule = false;
        schedule.resolved_block_id = None;
        schedule.prompt_shown_for = None;
        schedule.prompt_locking = false;
        schedule.countdown_deadline_ms = None;
        schedule.countdown_from_schedule = false;
        schedule.countdown_pending_activation = false;
        from_schedule
    };

    if should_stop_blocking {
        let mut active = state.study_mode_active.lock().unwrap();
        *active = false;
        disable_proxy_setting();
    }

    clear_window_topmost(app);
    let _ = app.emit("schedule-block-ended", ());
}

fn check_schedule(app: &tauri::AppHandle, last_block_id: &mut Option<String>) {
    let state = app.state::<AppState>();
    let now = now_ms();
    let (day, minutes) = local_day_and_minutes();

    let block_id = {
        let schedule = state.schedule.lock().unwrap();
        if is_paused(&schedule, now) {
            None
        } else {
            active_block(&schedule.blocks, day, minutes).map(|block| block.id.clone())
        }
    };

    if block_id.is_none() {
        if last_block_id.is_some() {
            end_scheduled_session(app);
        }
        *last_block_id = None;
        return;
    }

    let current_id = block_id.unwrap();
    // Only a real block change should forget the previous answer. The first
    // tick after launch has no previous id and must keep a choice just made.
    let entered_new_block = last_block_id
        .as_ref()
        .is_some_and(|previous| previous != &current_id);
    *last_block_id = Some(current_id.clone());

    if entered_new_block {
        let mut schedule = state.schedule.lock().unwrap();
        schedule.resolved_block_id = None;
        schedule.prompt_shown_for = None;
    }

    let (manual_stop, already_resolved, prompt_shown, countdown_deadline, countdown_from_schedule) = {
        let schedule = state.schedule.lock().unwrap();
        (
            schedule.manual_stop,
            schedule.resolved_block_id.as_ref() == Some(&current_id),
            schedule.prompt_shown_for.as_ref() == Some(&current_id),
            schedule.countdown_deadline_ms,
            schedule.countdown_from_schedule,
        )
    };

    if let Some(deadline) = countdown_deadline {
        if now >= deadline {
            let mut schedule = state.schedule.lock().unwrap();
            schedule.countdown_deadline_ms = None;
            schedule.countdown_pending_activation = true;
        } else {
            return;
        }
    }

    let study_active = *state.study_mode_active.lock().unwrap();
    let countdown_ready = {
        let mut schedule = state.schedule.lock().unwrap();
        if schedule.countdown_pending_activation && study_active {
            schedule.countdown_pending_activation = false;
        }
        schedule.countdown_pending_activation
    };
    if countdown_ready {
        let visible = app
            .get_webview_window(WINDOW_LABEL)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        force_show_main_window(app);
        if !visible {
            thread::sleep(std::time::Duration::from_millis(500));
        }
        let _ = app.emit("schedule-countdown-done", countdown_from_schedule);
        return;
    }

    if study_active || manual_stop || already_resolved {
        return;
    }

    let visible = app
        .get_webview_window(WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);

    if prompt_shown && visible {
        return;
    }

    {
        let mut schedule = state.schedule.lock().unwrap();
        schedule.prompt_locking = true;
    }

    force_show_main_window(app);
    if !visible {
        // Give WebView2 a moment to leave the suspended state before the event.
        thread::sleep(std::time::Duration::from_millis(500));
    }
    let _ = app.emit("schedule-prompt", current_id);
}

fn start_schedule_watcher(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut last_block_id: Option<String> = None;
        loop {
            thread::sleep(std::time::Duration::from_secs(5));
            check_schedule(&app, &mut last_block_id);
        }
    });
}

// ── Window Helpers ─────────────────────────────────────────────────────────

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
}

// ── App Entry Point ────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let blocked_sites = Arc::new(Mutex::new(Vec::new()));
    start_pac_server(blocked_sites.clone());
    start_block_proxy();

    tauri::Builder::default()
        .manage(AppState {
            study_mode_active: Mutex::new(false),
            blocked_sites,
            schedule: Mutex::new(ScheduleRuntime::default()),
        })
        .invoke_handler(tauri::generate_handler![
            open_clock_window,
            send_password_changed_email,
            set_study_mode_active,
            show_app_window,
            block_sites,
            unblock_sites,
            pause_study_mode_for_break,
            resume_study_mode_after_break,
            sync_schedule,
            claim_schedule_prompt,
            resolve_schedule_prompt,
            set_schedule_countdown,
            raise_for_schedule
        ])
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .setup(|app| {
            // Clean up any leftover hosts entries from previous versions
            cleanup_hosts_on_startup();
            // Clean up any leftover proxy settings from a previous crash
            cleanup_proxy_on_startup();

            if let Ok(autostart) = app.autolaunch().is_enabled() {
                if !autostart {
                    let _ = app.autolaunch().enable();
                }
            }

            start_schedule_watcher(app.handle().clone());

            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            let icon = app
                .default_window_icon()
                .ok_or("missing application icon")?
                .clone();

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("Study Mode")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "hide" => hide_main_window(app),
                    "quit" => {
                        let state = app.state::<AppState>();
                        let is_active = *state.study_mode_active.lock().unwrap();
                        if !is_active && !prompt_is_locking(app) {
                            cleanup_proxy_on_startup();
                            app.exit(0);
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "clock" {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }

                let app = window.app_handle();
                let state = app.state::<AppState>();
                let is_active = *state.study_mode_active.lock().unwrap();
                // Closing the window must not kill the process. The schedule
                // watcher has to keep running in the tray until the block starts.
                api.prevent_close();
                if !is_active && !prompt_is_locking(&app) {
                    hide_main_window(&app);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    let state = app_handle.state::<AppState>();
                    let is_active = *state.study_mode_active.lock().unwrap();
                    if is_active || prompt_is_locking(app_handle) {
                        api.prevent_exit();
                    }
                } else {
                    cleanup_proxy_on_startup();
                }
            }
        });
}
