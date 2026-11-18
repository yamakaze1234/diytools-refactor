[CmdletBinding()]
param([switch]$Acceptance, [switch]$Legacy)

$ErrorActionPreference = 'Stop'
$taskRepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if ($Acceptance -and $Legacy) { throw '请选择一个桌面模式。' }
$taskPreviousCli = $env:DIYTOOLS_AGENT_CLI_PATH
Push-Location -LiteralPath $taskRepoRoot
try {
    & cargo build --release --locked --manifest-path packages/agent-cli/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Agent CLI build failed.' }
    $taskCliTarget = Join-Path $taskRepoRoot 'packages/agent-cli/target'
    $taskDesktopTarget = Join-Path $taskRepoRoot 'apps/desktop/src-tauri/target'
    if ($env:CARGO_TARGET_DIR) {
        $taskCliTarget = [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
        $taskDesktopTarget = $taskCliTarget
    }
    # 嵌入刚从当前源码构建的 CLI，避免继承旧版本路径。
    $env:DIYTOOLS_AGENT_CLI_PATH = Join-Path $taskCliTarget 'release/diytools-agent.exe'
    $taskDesktopArgs = @('--no-bundle', '--features')
    if ($Legacy) {
        $taskDesktopArgs += 'agent-tools'
    } elseif ($Acceptance) {
        $taskDesktopArgs += @('nas-acceptance,agent-tools', '--config', 'src-tauri/tauri.nas-acceptance.conf.json')
    } else {
        $taskDesktopArgs += @('formal-nas-client,agent-tools', '--config', 'src-tauri/tauri.nas-intel-production.conf.json')
    }
    & pnpm --filter '@diytools/desktop' tauri build @taskDesktopArgs
    if ($LASTEXITCODE -ne 0) { throw 'Agent-enabled desktop build failed.' }
    Write-Output ('CLI: ' + $env:DIYTOOLS_AGENT_CLI_PATH)
    Write-Output ('Desktop: ' + (Join-Path $taskDesktopTarget 'release/desktop.exe'))
    Write-Output 'Build complete. No installer, installation, or application launch was performed.'
} finally {
    $env:DIYTOOLS_AGENT_CLI_PATH = $taskPreviousCli
    Pop-Location
}
