# 从当前源码构建带合成服务的桌面，只复制指定 SQL 种子与测试证书到独立目录。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Fixture,
    [ValidateSet('033','034')][string]$ActivityVersion='033'
)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$seed=(Resolve-Path -LiteralPath $Fixture).Path
if(Test-Path -LiteralPath (Join-Path $seed 'real-samples.json')){throw '请选择纯合成夹具目录'}
$envNames=@('DIYTOOLS_AGENT_CLI_PATH','TAURI_CONFIG','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','DIYTOOLS_AGENT_ENABLED','DIYTOOLS_P1_ACTIVITY_VERSION','CARGO_TARGET_DIR')
$previous=@{}
foreach($name in $envNames){$previous[$name]=[Environment]::GetEnvironmentVariable($name)}
$taskStage=Join-Path $repo ('sandbox/agent-nas-p1-'+[guid]::NewGuid().ToString())
$appProcess=$null
Push-Location -LiteralPath $repo
try{
    # Tauri 将 dist 编译进二进制，每次验收先从当前源码生成前端资源。
    & pnpm --dir apps/desktop build
    if($LASTEXITCODE){throw '工作台前端构建失败'}
    $env:CARGO_TARGET_DIR=Join-Path $repo 'packages/agent-cli/target'
    & cargo build --offline --locked --release --manifest-path packages/agent-cli/Cargo.toml
    if($LASTEXITCODE){throw 'CLI 构建失败'}
    $env:DIYTOOLS_AGENT_CLI_PATH=Join-Path $env:CARGO_TARGET_DIR 'release/diytools-agent.exe'
    $env:CARGO_TARGET_DIR=Join-Path $repo 'apps/desktop/src-tauri/target'
    $env:TAURI_CONFIG=Get-Content -Raw apps/desktop/src-tauri/tauri.nas-acceptance.conf.json
    & cargo build --offline --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --bin desktop --features custom-protocol,nas-acceptance,agent-tools
    if($LASTEXITCODE){throw '隔离桌面构建失败'}
    $engine=Join-Path $taskStage '验收服务'
    $toolsDir=Join-Path $engine 'services/nas-api/tools'
    $fixtureDir=Join-Path $engine 'fixture'
    $null=New-Item -Type Directory -Path $toolsDir,$fixtureDir
    foreach($file in @('intel-fixture.sql','gigabyte/02-gigabyte-import.sql','jonsbo/02-jonsbo-import.sql','access/04-install-three-operations-private.sql','test-ca.pem','test-cert.pem','test-key.pem')){
        $dest=Join-Path $fixtureDir $file
        $null=New-Item -Type Directory -Force -Path (Split-Path -Parent $dest)
        Copy-Item -LiteralPath (Join-Path $seed $file) -Destination $dest
    }
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $engine 'node.exe')
    # 引用本仓的 NAS 与脚手架，依赖由它们自己的 node_modules 解析。
    $modulePath=(Resolve-Path tools/agent-nas-p1-fixture.mjs).Path|ConvertTo-Json -Compress
    Set-Content -LiteralPath (Join-Path $toolsDir 'shared-sources-acceptance.mjs') -Encoding utf8 -Value "import {pathToFileURL} from 'node:url'; await import(pathToFileURL($modulePath).href);"
    $exe=Join-Path $taskStage 'p1-acceptance.exe'
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'debug/desktop.exe') -Destination $exe
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $listener.Start()
    try{$port=$listener.LocalEndpoint.Port}finally{$listener.Stop()}
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port --remote-debugging-address=127.0.0.1 --disable-background-networking --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows"
    $env:DIYTOOLS_AGENT_ENABLED='1'
    $env:DIYTOOLS_P1_ACTIVITY_VERSION=$ActivityVersion
    $appProcess=Start-Process -FilePath $exe -WorkingDirectory $taskStage -WindowStyle Hidden -PassThru
    $connection=Join-Path $taskStage 'agent-connection.json'
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    while(!(Test-Path -LiteralPath $connection)){
        if($appProcess.HasExited -or [DateTime]::UtcNow -ge $deadline){throw "验收桌面未就绪，查看 $taskStage/acceptance-data/startup.log"}
        Start-Sleep -Milliseconds 250
    }
    if((Get-Content -Raw -LiteralPath $connection|ConvertFrom-Json).pid -ne $appProcess.Id){throw '连接文件与本次验收进程不匹配'}
    & node tools/agent-nas-p1-smoke.mjs $connection $port
    if($LASTEXITCODE){throw '三店 NAS 端到端验收失败'}
}finally{
    if($null -ne $appProcess -and !$appProcess.HasExited){
        $null=$appProcess.CloseMainWindow()
        if(!$appProcess.WaitForExit(5000)){$appProcess.Kill();$appProcess.WaitForExit()}
    }
    foreach($name in $envNames){[Environment]::SetEnvironmentVariable($name,$previous[$name])}
    Pop-Location
    Write-Host "隔离验收目录 $taskStage"
}
