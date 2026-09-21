$projectRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $projectRoot "src-tauri\target\release\study-mode-app.exe"
$launcher = Join-Path $projectRoot "launch-study-mode.bat"
$icon = Join-Path $projectRoot "src-tauri\icons\icon.ico"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Study Mode.lnk"

$target = if (Test-Path $exe) { $exe } else { $launcher }
if (-not (Test-Path $target)) {
    Write-Error "App not found: $target"
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = Split-Path $target
$shortcut.Description = "Start Study Mode"
if (Test-Path $icon) {
    $shortcut.IconLocation = "$icon,0"
}
$shortcut.Save()

Write-Host "Desktop shortcut created:"
Write-Host $shortcutPath
