use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

const WINDOW_LABEL: &str = "main";
const HOSTS_PATH: &str = r"C:\Windows\System32\drivers\etc\hosts";
const MARKER_BEGIN: &str = "# --- Study Mode BEGIN ---";
const MARKER_END: &str = "# --- Study Mode END ---";

struct AppState {
    study_mode_active: Mutex<bool>,
    blocked_sites: Arc<Mutex<Vec<String>>>,
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

    // 2. Set the AutoConfigURL registry key
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

    // 3. Notify Windows to refresh settings immediately
    unsafe {
        InternetSetOptionW(std::ptr::null_mut(), 39, std::ptr::null_mut(), 0);
        InternetSetOptionW(std::ptr::null_mut(), 37, std::ptr::null_mut(), 0);
    }

    Ok(())
}

#[tauri::command]
fn unblock_sites() -> Result<(), String> {
    // 1. Delete the AutoConfigURL registry key
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

    // 2. Notify Windows to refresh settings immediately
    unsafe {
        InternetSetOptionW(std::ptr::null_mut(), 39, std::ptr::null_mut(), 0);
        InternetSetOptionW(std::ptr::null_mut(), 37, std::ptr::null_mut(), 0);
    }

    Ok(())
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
        })
        .invoke_handler(tauri::generate_handler![
            set_study_mode_active,
            show_app_window,
            block_sites,
            unblock_sites
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
                        if !is_active {
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
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let is_active = *state.study_mode_active.lock().unwrap();
                if is_active {
                    api.prevent_close();
                } else {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                } else {
                    cleanup_proxy_on_startup();
                }
            }
        });
}
