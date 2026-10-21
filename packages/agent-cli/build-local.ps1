[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskRepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Push-Location -LiteralPath $taskRepoRoot
try {
    & cargo build --release --locked --manifest-path packages/agent-cli/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Agent CLI build failed.' }
    & pnpm --filter '@diytools/desktop' tauri build --no-bundle --features agent-tools
    if ($LASTEXITCODE -ne 0) { throw 'Agent-enabled desktop build failed.' }
    $taskCliTarget = Join-Path $taskRepoRoot 'packages/agent-cli/target'
    $taskDesktopTarget = Join-Path $taskRepoRoot 'apps/desktop/src-tauri/target'
    if ($env:CARGO_TARGET_DIR) {
        $taskCliTarget = [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
        $taskDesktopTarget = $taskCliTarget
    }
    Write-Output ('CLI: ' + (Join-Path $taskCliTarget 'release/diytools-agent.exe'))
    Write-Output ('Desktop: ' + (Join-Path $taskDesktopTarget 'release/desktop.exe'))
    Write-Output 'Build complete. No installer, installation, or application launch was performed.'
} finally {
    Pop-Location
}
