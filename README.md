# Study Mode

Study Mode is a Windows desktop app that helps students limit time on distracting websites. When Study Mode is on, selected websites are blocked so you can stay focused.

> **Phase 1** — The full UI is complete. Website blocking runs automatically in the background (Phase 2 will add scheduling and custom site management).

---

## What the app does

- When you open the app, a **startup pop-up** appears asking when to start Study Mode: **now**, in **5 minutes**, or in **10 minutes**. If you close the pop-up without choosing, Study Mode starts immediately.
- The **main screen** shows whether Study Mode is on or off, a list of blocked websites, and controls to start or stop it.
- While Study Mode is **on**, the following websites are blocked: YouTube, Instagram, TikTok, Twitter/X, Reddit.
- To **stop** Study Mode you must enter the password (`12345`).
- **The app cannot be closed while Study Mode is on** — it must be turned off first.
- Closing the window normally hides the app to the **system tray** (bottom-right, near the clock). Right-click the tray icon for Show / Hide / Quit.
- The app registers to **start automatically when Windows starts**.

---

## One-time setup (before the first start)

You only need to do this once on your computer.

### 1. Install programs

1. **Node.js** — https://nodejs.org/ (choose the recommended version)
2. **Rust** — https://rustup.rs/ (use the default options)
3. **Visual Studio Build Tools** — https://visualstudio.microsoft.com/visual-cpp-build-tools/  
   When installing, check **"Desktop development with C++"**

### 2. Add Rust to Windows

1. Press the **Windows** key, type **environment variables**, open **Edit environment variables for your account**
2. Under **User variables**, click **Path** → **Edit**
3. Click **New**, paste this, then click **OK** on every window:

   ```
   C:\Users\gabby\.cargo\bin
   ```

   (Replace `gabby` with your Windows username if different.)

4. **Close and reopen** your terminal so the change takes effect.

### 3. Install project files (once per machine)

Open **PowerShell** or **Windows Terminal**, paste these one at a time, and press **Enter** after each:

```
cd C:\Users\gabby\Projects\Study-mode-app
```

```
npm install
```

The **first time** you start the app it may take **5–10 minutes** while Rust compiles. Later starts are much faster.

---

## How to start the app (developer mode)

```
cd C:\Users\gabby\Projects\Study-mode-app
npm run tauri dev
```

Wait until a **Study Mode** window appears. Leave that terminal open while the app runs.

---

## How to build a standalone executable (for everyday use)

Run this once:

```
cd C:\Users\gabby\Projects\Study-mode-app
npm run tauri build
```

Afterwards, open the app by double-clicking:

```
C:\Users\gabby\Projects\Study-mode-app\src-tauri\target\release\study-mode-app.exe
```

An installer is also created under `src-tauri\target\release\bundle\nsis\`.

---

## How to stop the app

| Situation | How to stop |
|-----------|-------------|
| Study Mode is **off** | Tray → **Quit** |
| Study Mode is **on** | Enter password (`12345`) to turn it off first, then tray → **Quit** |
| Running in dev mode | Terminal → **Ctrl + C** |
| App is stuck | Task Manager → find **study-mode-app** → **End task** |

---

## Screens

### Startup pop-up
Appears every time the app opens. Choose when to start Study Mode, or close the pop-up to start immediately.

### Main screen
| Element | Purpose |
|---------|---------|
| Status badge | Shows **Off**, **Pending** (countdown), or **On** |
| Countdown banner | Visible when a 5- or 10-minute delay is active |
| **Start / Stop Study Mode** button | Toggles study mode (stopping requires the password) |
| Blocked Websites list | Shows which sites are blocked (dots turn red when active) |
| Open Clock / Scheduled / Blocked | Reserved for future features |

### Password pop-up
Appears when you press **Stop Study Mode**. Enter `12345` to confirm.

---

## If something goes wrong

| Problem | Fix |
|---------|-----|
| `cargo` or `program not found` | Redo the "Add Rust to Windows" step, restart terminal |
| App won't close | Study Mode is on — turn it off first (password: `12345`) |
| Cursor says "something running in background" | Tray → **Quit**, or terminal → **Ctrl + C** |
| Build failed / linker error | Install Visual Studio Build Tools with **Desktop development with C++** |

---

## Project structure (for developers)

| Path | Purpose |
|------|---------|
| `index.html` | App UI (startup modal, main screen, password modal) |
| `src/main.ts` | Frontend logic: timers, state, password, Tauri integration |
| `src/styles.css` | Design system: colors, layout, components |
| `src-tauri/src/lib.rs` | Rust backend: tray, autostart, close-prevention |
| `src-tauri/tauri.conf.json` | Window size, bundle config |

To run in development: `npm run tauri dev`  
To build a release: `npm run tauri build`
