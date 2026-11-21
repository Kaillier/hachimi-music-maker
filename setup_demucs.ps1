[CmdletBinding()]
param(
    [string]$Python = 'python',
    [switch]$UseCuda
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$runtime = Join-Path $PSScriptRoot 'backend/runtime/demucs'
$venv = Join-Path $runtime 'venv'
$demucsPython = Join-Path $venv 'Scripts/python.exe'
$modelHome = Join-Path $runtime 'huggingface'
$hubCache = Join-Path $modelHome 'hub'
$modelCache = Join-Path $hubCache 'models--adefossez--HTDemucs'

function Invoke-Python {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE."
    }
}

function Get-Sha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    try {
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
        finally { $hasher.Dispose() }
    } finally { $stream.Dispose() }
}

if (-not (Test-Path -LiteralPath $demucsPython -PathType Leaf)) {
    $base = Get-Command -Name $Python -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $base) {
        throw 'Install 64-bit Python for Windows and add it to PATH, or pass -Python C:\path\to\python.exe.'
    }
    @'
import platform
import sys
if sys.platform != "win32" or platform.machine().lower() != "amd64" or not (3, 10) <= sys.version_info[:2] <= (3, 14):
    raise SystemExit("Demucs setup requires Windows x64 Python 3.10 through 3.14.")
'@ | & $base.Source -
    if ($LASTEXITCODE -ne 0) {
        throw 'The selected interpreter is not supported for Demucs setup.'
    }
    Invoke-Python $base.Source @('-m', 'venv', $venv)
}

$pip = @('-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--retries', '2', '--timeout', '30')
if ($UseCuda) {
    Invoke-Python $demucsPython ($pip + @('--index-url', 'https://download.pytorch.org/whl/cu126', 'torch==2.12.1+cu126'))
}
Invoke-Python $demucsPython ($pip + @('--index-url', 'https://pypi.org/simple',
    'torch==2.12.1', 'demucs==4.1.0', 'soundfile==0.14.0', 'huggingface-hub==1.24.0',
    'socksio==1.0.0'))

# Pin the same upstream snapshot used by the project before the Windows migration.
$revision = 'bf35a81b663819a8255c8fefee17f9d812b786b5'
$snapshot = Join-Path $modelCache "snapshots/$revision"
$references = Join-Path $modelCache 'refs'
New-Item -ItemType Directory -Force $snapshot, $references | Out-Null
$modelFiles = [ordered]@{
    'htdemucs.yaml' = '239c445d0b14454d541ad8bd9bb271c9e536d267e8a4625208744cbb2e7bb66c'
    '955717e8.safetensors' = 'd9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd'
}
foreach ($name in $modelFiles.Keys) {
    $file = Join-Path $snapshot $name
    if ((Test-Path -LiteralPath $file -PathType Leaf) -and
        (Get-Sha256 $file) -eq $modelFiles[$name]) { continue }
    $pending = "$file.$([guid]::NewGuid().ToString('N')).part"
    try {
        Write-Host "Downloading Demucs model file $name..."
        & curl.exe --fail --location --retry 2 --connect-timeout 15 --max-time 600 --output $pending "https://huggingface.co/adefossez/HTDemucs/resolve/$revision/$name"
        if ($LASTEXITCODE -ne 0) {
            throw "The Demucs model download failed: $name"
        }
        if ((Get-Sha256 $pending) -ne $modelFiles[$name]) {
            throw "The downloaded model file failed its SHA-256 check: $name"
        }
        Move-Item -LiteralPath $pending -Destination $file -Force
    } finally {
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending }
    }
}
[IO.File]::WriteAllText((Join-Path $references 'main'), $revision)

$previousHome = $env:HF_HOME
$previousCache = $env:HF_HUB_CACHE
$previousOffline = $env:HF_HUB_OFFLINE
try {
    $env:HF_HOME = $modelHome
    $env:HF_HUB_CACHE = $hubCache
    $env:HF_HUB_OFFLINE = '1'
    @'
from demucs.pretrained import get_model
import torch
get_model("hf://adefossez/htdemucs")
print("Windows Demucs is ready. Device:", "CUDA" if torch.cuda.is_available() else "CPU")
'@ | & $demucsPython -
    if ($LASTEXITCODE -ne 0) {
        throw 'The Demucs offline model could not be loaded.'
    }
} finally {
    $env:HF_HOME = $previousHome
    $env:HF_HUB_CACHE = $previousCache
    $env:HF_HUB_OFFLINE = $previousOffline
}
