# 从干净源码发布；成功回读版本附件后才推进匿名更新通道，发布凭据不进入命令行或文件。
[CmdletBinding()]
param(
    [string]$SourcePath = (Split-Path -Parent $PSScriptRoot),
    [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
    [Parameter(Mandatory = $true)][string]$NotesPath,
    [Alias('ArtifactsPath')][string]$ArtifactsDirectory,
    [switch]$CreateRepository,
    [switch]$PublicRepository
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'gitea-credentials.ps1')
$site = 'https://gitea.cq360.top'
$repository = 'CoreStudio/diy-tools-refactor'
$apiRoot = "$site/api/v1"
$source = (Resolve-Path -LiteralPath $SourcePath).Path
$notesFile = (Resolve-Path -LiteralPath $NotesPath).Path
$manifestName = 'diytools-refactor-windows-x86_64.json'
$credential = $null
$client = $null

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program 执行失败，发布已停止。" }
}

# 只向固定站点发送 API 凭据，并禁止 HttpClient 自动跟随重定向。
function Invoke-GiteaApi([string]$Method, [string]$Path, $Body = $null, [switch]$AllowMissing) {
    if (-not $Path.StartsWith('/') -or $Path.Contains('..') -or $Path.Contains('?')) { throw 'API 路径不合法。' }
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), "$apiRoot$Path")
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('token', $credential.Token)
    if ($null -ne $Body) { $request.Content = [Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 15 -Compress), [Text.Encoding]::UTF8, 'application/json') }
    $response = $null
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        if ($AllowMissing -and [int]$response.StatusCode -eq 404) { return $null }
        if (-not $response.IsSuccessStatusCode) { throw "Gitea API $Method $Path 返回 HTTP $([int]$response.StatusCode)。" }
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if ($text) { return ($text | ConvertFrom-Json) }
    } finally { if ($response) { $response.Dispose() }; $request.Dispose() }
}

# 流式上传避免 ZIP 整体驻留内存；失败时保留草稿，不会覆盖既有正式发行。
function Add-GiteaAsset([long]$ReleaseId, [string]$FilePath, [string]$AssetName = '') {
    $name = if ($AssetName) { $AssetName } else { [IO.Path]::GetFileName($FilePath) }
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, "$apiRoot/repos/$repository/releases/$ReleaseId/assets?name=$([Uri]::EscapeDataString($name))")
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('token', $credential.Token)
    $multipart = [Net.Http.MultipartFormDataContent]::new()
    $streamContent = [Net.Http.StreamContent]::new([IO.File]::OpenRead($FilePath))
    $multipart.Add($streamContent, 'attachment', $name)
    $request.Content = $multipart
    $response = $null
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "上传 $name 失败，HTTP $([int]$response.StatusCode)。" }
        return ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json)
    } finally { if ($response) { $response.Dispose() }; $request.Dispose() }
}

# 附件回读只允许当前仓库下载路径和本站附件 UUID，跨站重定向不会携带凭据。
function Get-GiteaAssetHash([string]$Url, [bool]$Anonymous) {
    $current = [Uri]$Url
    for ($redirect = 0; $redirect -le 3; $redirect++) {
        $downloadPrefix = "/$repository/releases/download/"
        $attachment = $current.AbsolutePath -match '^/attachments/[0-9a-fA-F-]{36}$'
        if ($current.Scheme -ne 'https' -or $current.Host -ne 'gitea.cq360.top' -or -not $current.IsDefaultPort -or $current.Query -or $current.Fragment -or $current.UserInfo -or (-not $current.AbsolutePath.StartsWith($downloadPrefix) -and -not $attachment)) { throw '附件下载地址不属于指定发行仓库。' }
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $current)
        if (-not $Anonymous) { $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('token', $credential.Token) }
        $response = $null
        try {
            $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
                if (-not $response.Headers.Location) { throw '附件重定向缺少目标。' }
                $current = [Uri]::new($current, $response.Headers.Location)
                continue
            }
            if (-not $response.IsSuccessStatusCode) { throw "附件回读失败，HTTP $([int]$response.StatusCode)。" }
            $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            try { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) }
            finally { $stream.Dispose() }
        } finally { if ($response) { $response.Dispose() }; $request.Dispose() }
    }
    throw '附件重定向次数过多。'
}

function Assert-ReleaseAssets($Release, [string[]]$Files, [bool]$Anonymous) {
    foreach ($file in $Files) {
        $name = [IO.Path]::GetFileName($file)
        $matches = @($Release.assets | Where-Object name -EQ $name)
        if ($matches.Count -ne 1) { throw "发行附件 $name 缺失或重复。" }
        $expectedUrl = "$site/$repository/releases/download/$($Release.tag_name)/$name"
        if ($matches[0].browser_download_url -cne $expectedUrl) { throw "发行附件 $name 的地址不符合约定。" }
        $remoteHash = Get-GiteaAssetHash $expectedUrl $Anonymous
        if ($remoteHash -ne (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash) { throw "发行附件 $name 回读摘要不一致。" }
    }
}

# Git 的凭据仅在子进程环境中设置；固定 URL、关闭重定向和已有凭据助手，避免泄露或错账号。
function Push-GiteaSource([string]$Commit) {
    $start = [Diagnostics.ProcessStartInfo]::new('git')
    $start.WorkingDirectory = $source
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('push', "$site/$repository.git", "$($Commit):refs/heads/main")) { $start.ArgumentList.Add($argument) }
    foreach ($name in @($start.Environment.Keys)) {
        if ($name -like 'GIT_TRACE*' -or $name -like 'GIT_CONFIG*') { $start.Environment.Remove($name) | Out-Null }
    }
    $start.Environment['GIT_TERMINAL_PROMPT'] = '0'
    $start.Environment['GIT_CONFIG_COUNT'] = '3'
    $start.Environment['GIT_CONFIG_KEY_0'] = "http.$site/$repository.git.extraHeader"
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($credential.UserName):$($credential.Token)"))
    $start.Environment['GIT_CONFIG_VALUE_0'] = "Authorization: Basic $basic"
    $start.Environment['GIT_CONFIG_KEY_1'] = 'http.followRedirects'
    $start.Environment['GIT_CONFIG_VALUE_1'] = 'false'
    $start.Environment['GIT_CONFIG_KEY_2'] = 'credential.helper'
    $start.Environment['GIT_CONFIG_VALUE_2'] = ''
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        $process.Start() | Out-Null
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $null = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Gitea 源码推送失败，请检查仓库权限或分支状态；未输出可能含认证信息的 Git 日志。' }
    } finally { $start.Environment['GIT_CONFIG_VALUE_0'] = ''; $basic = $null; $process.Dispose() }
}

Push-Location -LiteralPath $source
try {
    $status = @(git status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $status.Count -gt 0) { throw '源码必须是已经提交的干净 Git 工作区。' }
    $commit = git rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw '无法读取源码提交。' }
    $version = (Get-Content -LiteralPath 'apps/desktop/src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
    if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw '无效的发行版本。' }
    $cargoText = Get-Content -LiteralPath 'apps/desktop/src-tauri/Cargo.toml' -Raw
    $cargoVersion = [regex]::Match($cargoText, '(?ms)\[package\].*?^version\s*=\s*"([^"]+)"').Groups[1].Value
    foreach ($other in @($cargoVersion, (Get-Content package.json -Raw | ConvertFrom-Json).version, (Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version)) {
        if ($other -ne $version) { throw 'Cargo、Tauri 和两个 package.json 的版本必须一致。' }
    }
    Invoke-Checked py @('-3', '-X', 'utf8', 'tools/audit-public-tree.py', '--root', '.')
    $builtHere = -not $ArtifactsDirectory
    if ($builtHere) {
        Invoke-Checked pnpm @('install', '--frozen-lockfile')
        $tests = @(Get-ChildItem apps/desktop/tests -Recurse -File -Filter '*.test.mjs' | ForEach-Object FullName)
        Invoke-Checked node (@('--test') + $tests + @('tools/package-portable-update.test.mjs', 'tools/verify-gitea-package.test.mjs'))
        Invoke-Checked cargo @('test', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--lib')
        # 先构建独立 CLI，再嵌入主 EXE；不能在 desktop build.rs 递归调用 Cargo。
        Invoke-Checked cargo @('build', '--release', '--locked', '--manifest-path', 'packages/agent-cli/Cargo.toml')
        Invoke-Checked cargo @('test', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--lib', '--features', 'agent-tools')
        Invoke-Checked pnpm @('build:desktop', '--no-bundle', '--features', 'agent-tools')
        $ArtifactsDirectory = Join-Path $source ("release/gitea-$version-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path (Split-Path -Parent $ArtifactsDirectory) -Force | Out-Null
        $targetDirectory = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR, $source) } else { Join-Path $source 'apps/desktop/src-tauri/target' }
        $executable = Join-Path $targetDirectory 'release/desktop.exe'
        Invoke-Checked node @('tools/package-public-release.mjs', '--key', $PrivateKeyPath, '--exe', $executable, '--out', $ArtifactsDirectory, '--notes', $notesFile)
    }
    $ArtifactsDirectory = (Resolve-Path -LiteralPath $ArtifactsDirectory).Path
    $artifact = Join-Path $ArtifactsDirectory "diytools-refactor-$version-windows-x86_64.exe"
    $provenancePath = Join-Path $ArtifactsDirectory 'build-provenance.json'
    if ($builtHere) {
        @{ sourceCommit = $commit; version = $version; artifactSha256 = (Get-FileHash -LiteralPath $artifact).Hash.ToLowerInvariant() } | ConvertTo-Json | Set-Content -LiteralPath $provenancePath -Encoding utf8NoBOM
    }
    # 预构建模式要求调用方保存本轮构建证据，避免误发其他提交产生的同版本程序。
    if (-not (Test-Path -LiteralPath $provenancePath)) { throw '缺少 build-provenance.json；预构建产物必须提供源码提交、版本和程序摘要证据。' }
    $provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
    if ($provenance.sourceCommit -cne $commit -or $provenance.version -cne $version -or $provenance.artifactSha256 -ine (Get-FileHash -LiteralPath $artifact).Hash) { throw '预构建产物与当前源码提交、版本或程序摘要不一致。' }
    $manifest = Join-Path $ArtifactsDirectory $manifestName
    $notesAsset = Join-Path $ArtifactsDirectory 'release-notes.md'
    if (-not (Test-Path -LiteralPath $notesAsset)) { Copy-Item -LiteralPath $notesFile -Destination $notesAsset }
    if ((Get-FileHash -LiteralPath $notesFile).Hash -ne (Get-FileHash -LiteralPath $notesAsset).Hash) { throw '附件更新说明与指定说明文件不同。' }
    $archive = Join-Path $ArtifactsDirectory "DIYTools-$version-Windows-x64.zip"
    if (-not (Test-Path -LiteralPath $archive)) {
        $portable = Join-Path $ArtifactsDirectory "DIYTools-$version-Windows-x64"
        Compress-Archive -LiteralPath $portable -DestinationPath $archive
    }
    Invoke-Checked node @((Join-Path $PSScriptRoot 'verify-gitea-package.mjs'), $source, $ArtifactsDirectory, $version)
    # ZIP 只含公开 EXE、便携标记和说明，绝不接受安装目录中的 data 或私有运行时。
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $rootName = "DIYTools-$version-Windows-x64/"
        $entries = @($zip.Entries | Where-Object { $_.Name })
        $expectedNames = @("${rootName}DIYTools.exe", "${rootName}diytools-portable.json", "${rootName}使用说明.md")
        $entryNames = @($entries | ForEach-Object { $_.FullName.Replace('\','/') })
        if ($entries.Count -ne 3 -or @($entryNames | Select-Object -Unique).Count -ne 3 -or @($entryNames | Where-Object { $_ -cnotin $expectedNames }).Count -gt 0) { throw 'ZIP 内容超出公开发行范围。' }
        $exeEntry = $entries | Where-Object { $_.FullName.Replace('\','/') -ceq "${rootName}DIYTools.exe" }
        $zipStream = $exeEntry.Open()
        try { $zipHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($zipStream)) } finally { $zipStream.Dispose() }
        if ($zipHash -ne (Get-FileHash -LiteralPath $artifact).Hash) { throw 'ZIP 内程序和签名 EXE 不一致。' }
        foreach ($textEntry in @($entries | Where-Object { $_.Name -ne 'DIYTools.exe' })) {
            $entryStream = $textEntry.Open()
            try { $entryHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($entryStream)) } finally { $entryStream.Dispose() }
            $expectedHash = if ($textEntry.Name -eq '使用说明.md') { (Get-FileHash -LiteralPath (Join-Path $source 'docs/PUBLIC-USAGE.md')).Hash } else { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("{`"mode`":`"portable`"}`n"))) }
            if ($entryHash -ne $expectedHash) { throw 'ZIP 内说明或便携标记与公开源码不一致。' }
        }
    } finally { $zip.Dispose() }
    if (@(git status --porcelain).Count -gt 0) { throw '构建后源码有未提交变化，发布已停止。' }
    $credential = Get-DIYGiteaCredential
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    $member = Invoke-GiteaApi GET '/user'
    if ($member.login -ne $credential.UserName) { throw '凭据账户与授权记录不一致。' }
    $repo = Invoke-GiteaApi GET "/repos/$repository" -AllowMissing
    if (-not $repo) {
        if (-not $CreateRepository) { throw '发行仓库不存在，首次发布请显式添加 -CreateRepository。' }
        $repo = Invoke-GiteaApi POST '/orgs/CoreStudio/repos' @{ name = 'diy-tools-refactor'; private = (-not [bool]$PublicRepository); auto_init = $false; default_branch = 'main'; description = 'DIY Tools 重构工作台：Windows 本地优先、配置管理与签名更新。' }
    }
    if ($repo.full_name -cne $repository -or [bool]$repo.private -eq [bool]$PublicRepository) { throw '仓库标识或可见性与发布参数不符；本脚本不自动更改既有仓库可见性。' }
    $tag = "refactor-v$version"
    if (Invoke-GiteaApi GET "/repos/$repository/releases/tags/$tag" -AllowMissing) { throw '该版本 Release 已存在；请使用新版本号，或人工检查失败草稿后再处理。' }
    if (Invoke-GiteaApi GET "/repos/$repository/tags/$tag" -AllowMissing) { throw '该版本 Git 标签已存在，禁止让新发行复用可能指向旧源码的标签。' }
    Push-GiteaSource $commit
    # 新仓库首次推送后分支 API 可能短暂未就绪；仅重试只读查询，绝不重复推送或创建发行。
    $remoteBranch = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $remoteBranch = Invoke-GiteaApi GET "/repos/$repository/branches/main"
            break
        } catch {
            if ($attempt -eq 3) { throw }
            Start-Sleep -Seconds 1
        }
    }
    if ($remoteBranch.commit.id -cne $commit) { throw '远端 main 与本次发行提交不一致。' }
    $notes = Get-Content -LiteralPath $notesAsset -Raw
    $release = Invoke-GiteaApi POST "/repos/$repository/releases" @{ tag_name = $tag; target_commitish = $commit; name = "DIY Tools $version"; body = $notes; draft = $true; prerelease = $false }
    $files = @($artifact, $archive, $notesAsset, $manifest)
    foreach ($file in $files) { $null = Add-GiteaAsset $release.id $file }
    $release = Invoke-GiteaApi GET "/repos/$repository/releases/$($release.id)"
    Assert-ReleaseAssets $release $files $false
    $release = Invoke-GiteaApi PATCH "/repos/$repository/releases/$($release.id)" @{ draft = $false; prerelease = $false }
    # 公开发行必须额外证明匿名附件可以完整下载，不能仅依赖发布者令牌的成功。
    Assert-ReleaseAssets $release $files ([bool]$PublicRepository)
    $channel = Invoke-GiteaApi GET "/repos/$repository/releases/tags/refactor-updates" -AllowMissing
    if (-not $channel) {
        $channel = Invoke-GiteaApi POST "/repos/$repository/releases" @{ tag_name = 'refactor-updates'; target_commitish = $commit; name = '软件更新通道'; body = '软件读取此处的签名清单，安装包与更新说明见版本发布。'; draft = $false; prerelease = $false }
    }
    # 先上传并回读候选附件，再短暂切换名称；失败会恢复旧清单名称，旧通道不会先被删除。
    $previous = @($channel.assets | Where-Object name -EQ $manifestName)
    if ($previous.Count -gt 1) { throw '更新通道含重复签名清单，需先人工检查。' }
    $suffix = [guid]::NewGuid().ToString('N')
    $pendingName = "pending-$suffix-$manifestName"
    $pending = Add-GiteaAsset $channel.id $manifest $pendingName
    $pendingUrl = "$site/$repository/releases/download/refactor-updates/$pendingName"
    if ((Get-GiteaAssetHash $pendingUrl ([bool]$PublicRepository)) -ne (Get-FileHash -LiteralPath $manifest).Hash) { throw '候选通道清单回读不符，旧清单保持不变。' }
    $oldRenamed = $false
    $newRenamed = $false
    try {
        if ($previous.Count -eq 1) {
            $null = Invoke-GiteaApi PATCH "/repos/$repository/releases/$($channel.id)/assets/$($previous[0].id)" @{ name = "previous-$suffix-$manifestName" }
            $oldRenamed = $true
        }
        $null = Invoke-GiteaApi PATCH "/repos/$repository/releases/$($channel.id)/assets/$($pending.id)" @{ name = $manifestName }
        $newRenamed = $true
        $channel = Invoke-GiteaApi PATCH "/repos/$repository/releases/$($channel.id)" @{ draft = $false; prerelease = $false }
        Assert-ReleaseAssets $channel @($manifest) ([bool]$PublicRepository)
    } catch {
        if ($newRenamed) { $null = Invoke-GiteaApi PATCH "/repos/$repository/releases/$($channel.id)/assets/$($pending.id)" @{ name = $pendingName } }
        if ($oldRenamed) { $null = Invoke-GiteaApi PATCH "/repos/$repository/releases/$($channel.id)/assets/$($previous[0].id)" @{ name = $manifestName } }
        throw '更新通道切换未完成；已尝试恢复原清单，版本 Release 已保留，请核对后继续。'
    }
    if ($oldRenamed) { $null = Invoke-GiteaApi DELETE "/repos/$repository/releases/$($channel.id)/assets/$($previous[0].id)" }
    Write-Output "已发布 $site/$repository/releases/tag/$tag 并验证更新通道；附件位于 $ArtifactsDirectory"
} finally {
    if ($client) { $client.Dispose() }
    if ($credential) { $credential.Token = $null; $credential = $null }
    Pop-Location
}
