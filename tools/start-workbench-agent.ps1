$ErrorActionPreference = 'Stop'
function Get-HostAgentConnection([string]$Program,[int]$ProcessId) {
    $taskConnectionPath=Join-Path $PSScriptRoot 'agent-connection.json'
    if (-not (Test-Path -LiteralPath $taskConnectionPath -PathType Leaf)) { return $null }
    try {
        $taskConnection=Get-Content -LiteralPath $taskConnectionPath -Raw | ConvertFrom-Json
        if ($taskConnection.pid -eq $ProcessId -and $taskConnection.exe -eq $Program -and $taskConnection.instance -eq ('desktop-'+$ProcessId) -and (Test-Path -LiteralPath $taskConnection.cli -PathType Leaf)) { return $taskConnection }
    } catch { }
    return $null
}
try {
    $taskProgram = Join-Path $PSScriptRoot 'DIY配置工作台-重构测试版.exe'
    if (-not (Test-Path -LiteralPath $taskProgram -PathType Leaf)) { throw "工作台程序不存在：$taskProgram" }
    $taskRunning = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq $taskProgram)
    if ($taskRunning.Count -gt 1) { throw '检测到多个工作台实例，请保留一个后再连接 Agent。' }
    if ($taskRunning.Count -eq 1) {
        $taskPid = $taskRunning[0].ProcessId
    } else {
        $env:DIYTOOLS_AGENT_ENABLED = '1'
        $taskProcess = Start-Process -FilePath $taskProgram -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
        $taskPid = $taskProcess.Id
    }
    # 新宿主可能选择被占用 CLI 的内容寻址路径；复用其真实连接，不回写猜测路径。
    for ($taskAttempt=0; $taskAttempt -lt 20; $taskAttempt++) {
        if (Get-HostAgentConnection $taskProgram $taskPid) { return }
        Start-Sleep -Milliseconds 250
    }
    $taskCli=Join-Path $PSScriptRoot 'diytools-agent.exe'
    if (-not (Test-Path -LiteralPath $taskCli -PathType Leaf)) { throw 'Agent CLI 尚未准备完成，请检查工作台提示。' }
    @{ instance=('desktop-'+$taskPid); pid=$taskPid; exe=$taskProgram; cli=$taskCli; updatedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'agent-connection.json') -Encoding utf8
} catch {
    # 无控制台入口失败时保留可定位的错误，VBS 再显示提示。
    $taskFailure = $_ | Out-String
    try {
        ('[{0}] {1}' -f (Get-Date).ToString('o'), $taskFailure) | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'agent-launch-error.log') -Encoding utf8
    } catch { }
    exit 1
}
