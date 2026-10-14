# 从干净的专用仓库发布签名程序，始终先验证版本附件，再推进软件更新通道。
param(
  [Parameter(Mandatory=$true)][string]$PrivateKeyPath,
  [Parameter(Mandatory=$true)][string]$NotesPath
)
$ErrorActionPreference = 'Stop'
$repository = 'yamakaze1234/diytools-refactor'
$project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project
function Run-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program 执行失败，发布未完成" }
}
if ((git status --porcelain).Length -gt 0) { throw '请先提交并审查源码，避免构建与发布标签不一致' }
$remote = git remote get-url origin
if ($remote -notin @("https://github.com/$repository.git", "git@github.com:$repository.git")) { throw 'origin 不是指定发行仓库' }
$version = (Get-Content apps/desktop/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw '无效版本号' }
$cargoText = Get-Content apps/desktop/src-tauri/Cargo.toml -Raw
$cargoVersion = [regex]::Match($cargoText, '(?ms)\[package\].*?^version\s*=\s*"([^"]+)"').Groups[1].Value
foreach ($otherVersion in @($cargoVersion, (Get-Content package.json -Raw | ConvertFrom-Json).version, (Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version)) {
  if ($otherVersion -ne $version) { throw 'Cargo、Tauri 和两个 package.json 的版本必须一致' }
}
$tag = "refactor-v$version"
# 已存在的版本附件不能原地替换，使用新版本号重新发行。
gh release view $tag --repo $repository *> $null
if ($LASTEXITCODE -eq 0) { throw '版本已发布，请递增版本号' }
Run-Checked py @('-3', '-X', 'utf8', 'tools/audit-public-tree.py', '--root', '.')
Run-Checked pnpm @('install', '--frozen-lockfile')
$tests = @(Get-ChildItem apps/desktop/tests -Recurse -File -Filter '*.test.mjs' | ForEach-Object FullName)
Run-Checked node (@('--test') + $tests + @('tools/package-portable-update.test.mjs'))
Run-Checked cargo @('test', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--lib')
Run-Checked pnpm @('build:desktop', '--no-bundle')
$output = Join-Path $project ("release/publish-" + $version + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
Run-Checked node @('tools/package-public-release.mjs', '--key', $PrivateKeyPath, '--exe', 'apps/desktop/src-tauri/target/release/desktop.exe', '--out', $output, '--notes', $NotesPath)
$build = Get-Content (Join-Path $output 'release-build.json') -Raw | ConvertFrom-Json
$archive = Join-Path $output "DIYTools-$version-Windows-x64.zip"
Compress-Archive -LiteralPath $build.portable -DestinationPath $archive
$artifact = Join-Path $output $build.artifact
$manifest = Join-Path $output $build.manifest
$commit = git rev-parse HEAD
Run-Checked git @('push', 'origin', 'HEAD')
Run-Checked gh @('release', 'create', $tag, $artifact, $archive, $manifest, '--repo', $repository, '--target', $commit, '--title', "DIY Tools $version", '--notes-file', $NotesPath, '--draft')
# 下载已上传附件到新的验证目录，逐文件摘要相等后才发布和更新通道。
$verify = Join-Path $output 'verify'
Run-Checked gh @('release', 'download', $tag, '--repo', $repository, '--dir', $verify)
foreach ($file in @($artifact, $archive, $manifest)) {
  if ((Get-FileHash -LiteralPath $file).Hash -ne (Get-FileHash -LiteralPath (Join-Path $verify (Split-Path -Leaf $file))).Hash) { throw '远端附件摘要不符，通道未更新' }
}
Run-Checked gh @('release', 'edit', $tag, '--repo', $repository, '--draft=false', '--latest')
gh release view refactor-updates --repo $repository *> $null
if ($LASTEXITCODE -ne 0) {
  Run-Checked gh @('release', 'create', 'refactor-updates', $manifest, '--repo', $repository, '--target', $commit, '--title', '软件更新通道', '--notes', '软件读取此处的签名清单；安装包见版本发布。', '--latest=false')
} else {
  Run-Checked gh @('release', 'upload', 'refactor-updates', $manifest, '--repo', $repository, '--clobber')
  Run-Checked gh @('release', 'edit', 'refactor-updates', '--repo', $repository, '--prerelease=false', '--latest=false')
}
Write-Output "已发布 $tag 并更新软件通道。附件位于 $output"
