$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot "launch-study-mode.bat"
$icon = Join-Path $projectRoot "src-tauri\icons\icon.ico"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Study Mode.lnk"

if (-not (Test-Path $launcher)) {
    Write-Error "Launcher not found: $launcher"
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = "Start Study Mode"
if (Test-Path $icon) {
    $shortcut.IconLocation = "$icon,0"
}
$shortcut.Save()

Write-Host "Desktop shortcut created:"
Write-Host $shortcutPath
