# adding to window startup

## Goal

Make Study Mode start automatically when Windows starts.

## Current status

This is already implemented in the app code with the Tauri autostart plugin.

The important files are:

- `src-tauri/Cargo.toml`
  - Includes `tauri-plugin-autostart`.
- `src-tauri/capabilities/default.json`
  - Includes the `autostart:default` permission.
- `src-tauri/src/lib.rs`
  - Registers the autostart plugin.
  - Enables autostart during app setup if it is not already enabled.

## Code that enables startup

In `src-tauri/src/lib.rs`, the app registers the plugin:

```rust
.plugin(tauri_plugin_autostart::Builder::new().build())
```

Then, during setup, it checks whether startup is enabled and turns it on if needed:

```rust
if let Ok(autostart) = app.autolaunch().is_enabled() {
    if !autostart {
        let _ = app.autolaunch().enable();
    }
}
```

## How to test it

1. Run the app:

```powershell
npm run tauri dev
```

2. Let the app open at least once. This lets it register itself for Windows startup.

3. Close the app from the tray menu:

- Right-click the Study Mode tray icon.
- Click `Quit`.

4. Restart Windows.

5. After signing back in, Study Mode should open automatically.

## How to run the app outside Cursor

For everyday use, build and install the real Windows app instead of running it through Cursor.

1. Open PowerShell.

2. Go to the project folder:

```powershell
cd C:\Users\gabby\Projects\Study-mode-app
```

3. Build the Windows app:

```powershell
npm run tauri build
```

4. When the build finishes, open this folder:

```text
C:\Users\gabby\Projects\Study-mode-app\src-tauri\target\release\bundle\nsis
```

5. Double-click the installer file in that folder.

6. Finish the installer steps.

7. Open Study Mode once from the Windows Start Menu.

8. Let the app fully load. This gives it a chance to register itself for Windows startup.

9. After that, Study Mode should open automatically whenever the computer powers on and you sign in.

Important: Windows startup apps open after you sign in to your Windows account. They do not open before the login screen.

## How to verify in Windows

1. Press `Ctrl + Shift + Esc` to open Task Manager.
2. Click `Startup apps`.
3. Look for `Study Mode` or the app executable name.
4. It should be enabled.

## If it does not start automatically

Try these steps:

1. Run the app once with:

```powershell
npm run tauri dev
```

2. Fully quit the app from the tray.

3. Build and run the installed version, because Windows startup is more reliable with an installed app:

```powershell
npm run tauri build
```

4. Install the generated app from:

```text
src-tauri\target\release\bundle
```

5. Open the installed app once, then restart Windows again.

## Notes

- This does not require manually adding a shortcut to the Windows Startup folder.
- The app uses the Tauri autostart plugin so Windows can manage startup registration.
- The app also cleans up old blocking/proxy settings when it starts.

