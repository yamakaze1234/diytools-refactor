param(
    [Parameter(Mandatory)][string]$InstallDirectory,
    [Parameter(Mandatory)][string]$ShortcutPath,
    [Parameter(Mandatory)][string]$BackupDirectory,
    [string]$PowerShellPath = (Get-Process -Id $PID).Path
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请在 PowerShell 7 中执行。' }
$taskInstall = (Resolve-Path -LiteralPath $InstallDirectory).Path
$taskExe = Join-Path $taskInstall 'DIY配置工作台-重构测试版.exe'
$taskWscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
foreach ($taskPath in @($taskExe, $ShortcutPath, $PowerShellPath, $taskWscript)) {
    if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { throw "文件不存在：$taskPath" }
}
if (Test-Path -LiteralPath $BackupDirectory) { throw '备份目录已存在；请选择新目录，避免覆盖回退文件。' }
New-Item -ItemType Directory -Path $BackupDirectory | Out-Null
$taskShell = New-Object -ComObject WScript.Shell
$taskShortcut = $taskShell.CreateShortcut($ShortcutPath)
$taskBefore = @{ target=$taskShortcut.TargetPath; arguments=$taskShortcut.Arguments; workingDirectory=$taskShortcut.WorkingDirectory; windowStyle=$taskShortcut.WindowStyle; exeSha256=(Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash; shortcutPath=$ShortcutPath; installDirectory=$taskInstall }
$taskBefore | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BackupDirectory 'before.json') -Encoding utf8
Copy-Item -LiteralPath $ShortcutPath -Destination (Join-Path $BackupDirectory 'original-shortcut.lnk')
foreach ($taskName in @('start-workbench-agent.ps1', 'start-workbench-agent.vbs')) {
    $taskDestination = Join-Path $taskInstall $taskName
    if (Test-Path -LiteralPath $taskDestination) { Copy-Item -LiteralPath $taskDestination -Destination (Join-Path $BackupDirectory $taskName) }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $taskName) -Destination $taskDestination
}
# 快捷方式先启动无控制台宿主，避免 PowerShell 隐藏窗口之前闪现。
$taskShortcut.TargetPath = $taskWscript
$taskShortcut.Arguments = '//nologo "{0}" "{1}"' -f (Join-Path $taskInstall 'start-workbench-agent.vbs'), $PowerShellPath
$taskShortcut.WorkingDirectory = $taskInstall
$taskShortcut.WindowStyle = 1
$taskShortcut.Save()
if ((Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash -ne $taskBefore.exeSha256) { throw '工作台 EXE 摘要发生变化，请检查。' }
[pscustomobject]@{ backupDirectory=$BackupDirectory; shortcutPath=$ShortcutPath; target=$taskShortcut.TargetPath; arguments=$taskShortcut.Arguments; exeUnchanged=$true }
