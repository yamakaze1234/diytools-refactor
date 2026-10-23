# 构建 Windows ERP worker 并验证离线 JSONL 协议；构建与测试都使用本次独立目录，只输出本机可选运行时。
# Run with PowerShell 7: pwsh -File tools/build-erp-worker.ps1
# The locked build is reproducible from source, not guaranteed byte-identical PE output.
[CmdletBinding()]
param([string]$OutputPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Build the Windows ERP worker with PowerShell 7 on Windows.'
}
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workerRoot = Join-Path $repoRoot 'services/erp-worker'
$runRoot = Join-Path $repoRoot ('sandbox/erp-worker-build/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
# 默认只生成独立可选运行时，不写入主 EXE 资源，也不修改已有开发私有环境。
$resource = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $runRoot 'optional-runtime/erp-worker.exe' }
$paths = @('temp', 'work', 'dist', 'spec', 'source', 'runtime')
New-Item -ItemType Directory -Path $runRoot | Out-Null
foreach ($path in $paths) { New-Item -ItemType Directory -Path (Join-Path $runRoot $path) | Out-Null }
$reportFile = Join-Path $runRoot 'report.json'
$savedEnv = @{}
foreach ($key in @('UV_PROJECT_ENVIRONMENT', 'UV_CACHE_DIR', 'PYINSTALLER_CONFIG_DIR', 'TEMP', 'TMP', 'PYTHONUTF8')) {
    $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
$report = [ordered]@{
    status = 'started'; started_at = (Get-Date).ToUniversalTime().ToString('o')
    run_directory = $runRoot; resource = $resource; python_required = '3.13.6'
    build_mode = 'console onefile; parent must use CREATE_NO_WINDOW and redirected stdin/stdout'
    verified_scope = 'offline imports and JSONL status/invalid/disconnect/SQL invalid/settings vault load/tombstone/EOF; no ERP or SQL network'
    cleanup_candidates = @($paths | ForEach-Object { Join-Path $runRoot $_ })
}
# 每个构建阶段写回证据，失败时也能定位最后已完成步骤。
function Save-Report { $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $reportFile -Encoding utf8 }
# 保留命令日志并立即检查退出码，外部命令失败不能继续发布资源。
function Invoke-Logged([string]$Executable, [string[]]$Arguments, [string]$LogName) {
    & $Executable @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $runRoot $LogName) | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited with $LASTEXITCODE; see $LogName" }
}
# 登记锁文件及 worker 源码摘要，把可复现构建与实际输入绑定。
function Get-SourceHashes {
    @('services/erp-worker/main.py', 'services/erp-worker/session.py', 'services/erp-worker/cost_file.py', 'services/erp-worker/sql_service.py', 'services/erp-worker/sql_credentials.py', 'services/erp-worker/pyproject.toml', 'services/erp-worker/uv.lock', 'tools/build-erp-worker.ps1') | ForEach-Object {
        $file = Join-Path $repoRoot $_
        [ordered]@{ path = $_; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $file).Length }
    }
}
# 使用隐藏子进程与 UTF-8 管道，在独立 runtime 目录和测试凭据路径运行。
function Start-Worker([string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path $runRoot 'dist/erp-worker.exe'
    $info.WorkingDirectory = Join-Path $runRoot 'runtime'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $info.Environment['DIYTOOLS_SQL_VAULT'] = Join-Path $runRoot 'runtime/sql-credentials-test.dpapi.json'
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    [void]$process.Start()
    return $process
}
# 每次只读一条 JSONL 响应并设置等待上限，防止构建因 worker 无响应长期挂起。
function Read-Response($Process) {
    $task = $Process.StandardOutput.ReadLineAsync()
    if (-not $task.Wait(60000)) { throw 'ERP worker JSONL response timeout (60 seconds).' }
    $line = $task.GetAwaiter().GetResult()
    if ($null -eq $line) { throw 'ERP worker closed stdout before responding.' }
    return ConvertFrom-Json -InputObject $line
}
# 关闭标准输入触发 EOF 正常退出，并检查是否有多余输出或错误。
function Finish-Worker($Process, $StderrTask) {
    $Process.StandardInput.Close()
    $extra = $Process.StandardOutput.ReadToEndAsync()
    if (-not $Process.WaitForExit(60000)) { throw 'ERP worker EOF exit timeout (60 seconds).' }
    $stderr = $StderrTask.GetAwaiter().GetResult()
    if ($Process.ExitCode -ne 0 -or $extra.GetAwaiter().GetResult().Trim() -ne '' -or $stderr.Trim() -ne '') {
        throw "ERP worker unexpected exit/output: exit=$($Process.ExitCode), stderr=$stderr"
    }
}
try {
    # 将依赖和打包临时文件限定到本次构建路径；finally 恢复原进程环境。
    $env:UV_CACHE_DIR = Join-Path $repoRoot 'sandbox/uv-cache'
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $runRoot 'build-venv'
    $env:PYINSTALLER_CONFIG_DIR = Join-Path $runRoot 'work/pyinstaller-cache'
    $env:TEMP = Join-Path $runRoot 'temp'
    $env:TMP = $env:TEMP
    $env:PYTHONUTF8 = '1'
    $uv = (Get-Command uv -ErrorAction Stop).Source
    Invoke-Logged $uv @('sync', '--project', $workerRoot, '--python', '3.13.6', '--group', 'build', '--locked') 'uv-sync.log'
    $python = Join-Path $env:UV_PROJECT_ENVIRONMENT 'Scripts/python.exe'
    # 下面的内嵌 Python 仅采集版本和来源摘要，随后严格对照锁定依赖，不建立 ERP 连接。
    $inventoryCode = @'
import importlib.metadata as m, json, platform, struct
print(json.dumps({'python': platform.python_version(), 'machine': platform.machine(), 'bits': struct.calcsize('P') * 8, 'packages': {d.metadata['Name']: d.version for d in m.distributions()}}, ensure_ascii=False))
'@
    $inventoryJson = & $python -c $inventoryCode
    if ($LASTEXITCODE -ne 0) { throw 'Dependency inventory failed.' }
    $report['dependencies'] = $inventoryJson | ConvertFrom-Json
    if ($report.dependencies.python -ne '3.13.6' -or $report.dependencies.bits -ne 64 -or $report.dependencies.machine -ne 'AMD64') {
        throw 'Python differs from the fixed generic worker build.'
    }
    if ($report.dependencies.packages.'python-tds' -ne '1.17.1' -or $report.dependencies.packages.pyOpenSSL -ne '26.4.0' -or $report.dependencies.packages.cryptography -ne '50.0.1') {
        throw 'SQL driver or TLS dependencies differ from the fixed build.'
    }
    $report['source_files'] = @(Get-SourceHashes)
    foreach ($source in $report.source_files) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $source.path) -Destination (Join-Path $runRoot ('source/' + [IO.Path]::GetFileName($source.path)))
    }
    $arguments = @('-m', 'PyInstaller', '--onefile', '--console', '--noconfirm', '--noupx', '--name', 'erp-worker',
        '--distpath', (Join-Path $runRoot 'dist'), '--workpath', (Join-Path $runRoot 'work'), '--specpath', (Join-Path $runRoot 'spec'),
        '--copy-metadata', 'python-tds', '--copy-metadata', 'pyOpenSSL', '--copy-metadata', 'cryptography', '--collect-data', 'certifi',
        '--collect-submodules', 'pytds', '--hidden-import', 'OpenSSL', '--hidden-import', 'cost_file', '--collect-submodules', 'pyxlsb', '--collect-submodules', 'openpyxl', '--hidden-import', 'sql_service', '--hidden-import', 'sql_credentials',
        (Join-Path $runRoot 'source/main.py'))
    $report['pyinstaller_arguments'] = $arguments
    Save-Report
    Invoke-Logged $python $arguments 'pyinstaller.log'
    $builtExe = Join-Path $runRoot 'dist/erp-worker.exe'
    # Inspect only the archive table of contents; no package code or ERP client is executed here.
    & $python -m PyInstaller.utils.cliutils.archive_viewer -l -r $builtExe 2>&1 | Set-Content -LiteralPath (Join-Path $runRoot 'archive-contents.txt') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Frozen archive inspection failed.' }
    $archive = Get-Content -LiteralPath (Join-Path $runRoot 'archive-contents.txt') -Raw
    if ($archive -match "(?im)^.*'[^']*(?:\.env(?:\.[^']*)?|\.(?:sqlite3?|db))'\s*$") { throw 'Unexpected environment/database file in worker archive.' }
    $report['archive_audit'] = 'No .env or SQLite/database entries; package modules and installed distribution metadata only.'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Worker @()
    try {
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $environment = Read-Response $process
        Finish-Worker $process $stderrTask
    } finally {
        if (-not $process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(10000) }
        $process.Dispose()
    }
    $watch.Stop()
    if ($environment.service -ne 'diytools-erp-worker' -or $environment.python -ne '3.13.6' -or $environment.erp_package.status -ne 'missing' -or $environment.erp_connected -ne $false) {
        throw 'Frozen worker default environment check did not report the expected optional/offline state.'
    }
    $report['environment'] = $environment
    $report['default_startup_and_exit_ms'] = $watch.ElapsedMilliseconds
    $responses = @()
    $process = Start-Worker @('--serve')
    try {
        $stderrTask = $process.StandardError.ReadToEndAsync()
        foreach ($action in @('status', 'invalid_action', 'disconnect')) {
            $id = 'build-' + $action
            $process.StandardInput.WriteLine((@{ id = $id; action = $action } | ConvertTo-Json -Compress))
            $process.StandardInput.Flush()
            $response = Read-Response $process
            if ($response.id -ne $id) { throw 'Frozen JSONL response correlation failed.' }
            if ($action -eq 'invalid_action') {
                if ($response.ok -ne $false -or $response.error.code -ne 'UNKNOWN_ACTION') { throw 'Invalid action check failed.' }
            } elseif ($response.ok -ne $true -or $response.result.connected -ne $false -or $response.result.package_version -ne 'external-adapter') {
                throw "Offline $action check failed."
            }
            if ($process.HasExited) { throw 'JSONL worker did not retain its session.' }
            $responses += $response
        }
        foreach ($action in @('sql_credentials_load', 'sql_credentials_clear', 'sql_read')) {
            $id = 'build-' + $action
            $process.StandardInput.WriteLine((@{ id = $id; action = $action } | ConvertTo-Json -Compress))
            $process.StandardInput.Flush()
            $response = Read-Response $process
            if ($response.id -ne $id) { throw 'Frozen SQL JSONL response correlation failed.' }
            if ($action -eq 'sql_read') {
                if ($response.ok -ne $false -or $response.error.code -ne 'INVALID_REQUEST') { throw 'Frozen SQL validation check failed.' }
            } elseif ($response.ok -ne $true -or $response.result.saved -ne $false) {
                throw 'Frozen isolated SQL vault check failed.'
            }
            $responses += $response
        }
        Finish-Worker $process $stderrTask
    } finally {
        if (-not $process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(10000) }
        $process.Dispose()
    }
    $report['jsonl_responses'] = $responses
    $process = Start-Worker @('--serve')
    try { Finish-Worker $process ($process.StandardError.ReadToEndAsync()) } finally {
        if (-not $process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(10000) }
        $process.Dispose()
    }
    $report['empty_eof_exit'] = 'passed'
    $currentHashes = @(Get-SourceHashes)
    if (($currentHashes | ConvertTo-Json -Compress) -ne ($report.source_files | ConvertTo-Json -Compress)) { throw 'Worker or build source changed while building; rebuild before publishing the resource.' }
    $report['exe'] = [ordered]@{ sha256 = (Get-FileHash -LiteralPath $builtExe -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $builtExe).Length }
    New-Item -ItemType Directory -Force -Path (Split-Path $resource -Parent) | Out-Null
    if (Test-Path -LiteralPath $resource) { Copy-Item -LiteralPath $resource -Destination (Join-Path $runRoot 'previous-erp-worker.exe') }
    Copy-Item -LiteralPath $builtExe -Destination $resource
    if ((Get-FileHash -LiteralPath $resource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $report.exe.sha256) { throw 'Copied ERP resource hash differs.' }
    $report['status'] = 'complete'
    $report['completed_at'] = (Get-Date).ToUniversalTime().ToString('o')
    Save-Report
    Write-Host "ERP worker ready: $resource"
    Write-Host "Build and offline validation report: $reportFile"
} catch {
    $report['status'] = 'failed'
    $report['error'] = $_.Exception.Message
    Save-Report
    throw
} finally {
    foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process') }
}
