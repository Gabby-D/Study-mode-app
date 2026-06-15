# Study Mode

Study Mode is a Windows desktop app that helps students limit time on distracting websites. When Study Mode is on, selected websites are blocked across all browsers. When it is off, sites work normally again.

---

## What the app does

- When you open the app, a **startup pop-up** appears asking when to start Study Mode: **now**, in **5 minutes**, or in **10 minutes**. If you close the pop-up without choosing, Study Mode starts immediately.
- The **main screen** shows whether Study Mode is on or off, a list of blocked websites, and controls to start or stop it.
- **Website blocking** uses a local proxy auto-config (PAC) file. When Study Mode is on, blocked sites are redirected to a local block page. This works in Chrome, Edge, Firefox, Brave, and other browsers that respect Windows proxy settings.
- Blocking applies to **new tabs immediately**. For a video already playing, the stream is cut off within a few seconds when the next segment is requested — you do not need to reload the page.
- When Study Mode is turned **off**, sites become accessible again right away. Refresh or press play to continue where you left off.
- Default blocked sites: YouTube (`youtube.com` / `youtu.be`), Instagram, TikTok, Twitter/X, Reddit.
- Use the **Blocked** button to **add** sites (no password) or **delete** sites (password required: `12345`).
- To **stop** Study Mode you must enter the password (`12345`).
- **The app cannot be closed while Study Mode is on** — it must be turned off first.
- Closing the window normally hides the app to the **system tray** (bottom-right, near the clock). Right-click the tray icon for Show / Hide / Quit.
- The app registers to **start automatically when Windows starts**.

> **Note:** Scheduling and the Open Clock button are not implemented yet.

---

## One-time setup (before the first start)

You only need to do this once on your computer.

### 1. Install programs

1. **Node.js 20 LTS or newer** — https://nodejs.org/ (Vite 6 requires Node 18.20+; Node 20 LTS is recommended)
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

### 3. Allow PowerShell scripts (if needed)

If `npm` fails with a script execution policy error, run this once in PowerShell:

```
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### 4. Install project files (once per machine)

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

**Tip:** After the first compile, keep `npm run tauri dev` running while you edit frontend files (`index.html`, `src/main.ts`, `src/styles.css`) — changes reload automatically. Restart the command only if you change Rust files (`src-tauri/src/lib.rs`).

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
| **Blocked** button | Opens the manage-sites modal (add or delete sites) |
| Open Clock / Scheduled | Not implemented yet |

### Manage blocked sites modal
| Action | Password required? |
|--------|-------------------|
| Add a site | No |
| Delete a site | Yes (`12345`) |

### Password pop-up
Appears when you press **Stop Study Mode** or try to delete a blocked site. Enter `12345` to confirm.

---

## How blocking works (technical)

When Study Mode turns on, the app:

1. Starts serving a PAC file at `http://127.0.0.1:9998/proxy.pac` that lists blocked domains.
2. Sets Windows **AutoConfigURL** in your user registry (no administrator rights needed).
3. Routes blocked traffic through a local proxy on port `9999`, which returns a "Study Mode Active" block page.

When Study Mode turns off, the proxy setting is removed and browsers go back to direct connections.

Associated CDN domains (e.g. `googlevideo.com` for YouTube) are blocked automatically so active video streams stop without reloading.

---

## If something goes wrong

| Problem | Fix |
|---------|-----|
| `cargo` or `program not found` | Redo the "Add Rust to Windows" step, restart terminal |
| `npm` script blocked / execution policy | Run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` |
| `node:fs/promises` / Vite error on start | Update Node.js to **v20 LTS** from https://nodejs.org/ |
| App won't close | Study Mode is on — turn it off first (password: `12345`) |
| Sites not blocking | Turn Study Mode off and on again; try a new tab to the blocked site |
| Cursor says "something running in background" | Tray → **Quit**, or terminal → **Ctrl + C** |
| Build failed / linker error | Install Visual Studio Build Tools with **Desktop development with C++** |
| Proxy left on after crash | Restart the app — it cleans up leftover proxy settings on startup |

---

## Project structure (for developers)

| Path | Purpose |
|------|---------|
| `index.html` | App UI (startup modal, main screen, password modal, blocked-sites modal) |
| `src/main.ts` | Frontend logic: timers, state, password, site list, Tauri integration |
| `src/styles.css` | Design system: colors, layout, components |
| `src-tauri/src/lib.rs` | Rust backend: PAC server, block proxy, tray, autostart, close-prevention |
| `src-tauri/tauri.conf.json` | Window size, bundle config |

To run in development: `npm run tauri dev`  
To build a release: `npm run tauri build`
