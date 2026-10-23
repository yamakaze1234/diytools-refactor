param([string]$OutputDirectory)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
if(-not $OutputDirectory){$OutputDirectory=Join-Path $root 'sandbox/cost-reader-build'}
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$env:UV_PROJECT_ENVIRONMENT=Join-Path $OutputDirectory 'venv'
uv sync --project (Join-Path $root 'services/cost-reader') --locked --group build
if($LASTEXITCODE -ne 0){throw 'Cost reader dependency preparation failed'}
$python=Join-Path $env:UV_PROJECT_ENVIRONMENT 'Scripts/python.exe'
& $python -m PyInstaller --onefile --console --noconfirm --noupx --name cost-reader --distpath (Join-Path $OutputDirectory 'dist') --workpath (Join-Path $OutputDirectory 'work') --specpath $OutputDirectory --paths (Join-Path $root 'services/erp-worker') --collect-submodules pyxlsb --collect-submodules openpyxl (Join-Path $root 'services/cost-reader/main.py')
if($LASTEXITCODE -ne 0){throw 'Cost reader packaging failed'}
