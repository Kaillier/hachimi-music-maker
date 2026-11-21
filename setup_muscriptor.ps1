[CmdletBinding()]
param(
    [string]$Python = $env:HACHIMI_MUSCRIPTOR_PYTHON
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $Python) {
    $Python = Join-Path $root 'backend/runtime/demucs/venv/Scripts/python.exe'
}
$pythonPath = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $Python))
if (-not [IO.File]::Exists($pythonPath)) {
    throw 'Run setup_demucs.bat first, or pass -Python with a Windows Python environment that already has PyTorch.'
}

$dependencies = Join-Path $root 'backend/runtime/muscriptor-windows/deps'
& $pythonPath -X utf8 -c "import sys, torch, numpy, einops, safetensors, soundfile, huggingface_hub, packaging; assert sys.platform == 'win32'"
if ($LASTEXITCODE -ne 0) {
    throw 'The selected Python needs the dependencies installed by setup_demucs.bat.'
}

# Install only the required decoder and MIDI reader. The web and beat-grid extras are not used.
$packages = @('muscriptor==0.4.0', 'mido==1.3.3')
@'
import sys
from importlib.metadata import distributions
installed = {dist.metadata["Name"]: dist.version for dist in distributions(path=[sys.argv[1]])}
sys.exit(0 if all(installed.get(name) == version for name, version in
                  (spec.split("==", 1) for spec in sys.argv[2:])) else 1)
'@ | & $pythonPath -X utf8 - $dependencies @packages
if ($LASTEXITCODE -ne 0) {
    & $pythonPath -m pip --isolated --disable-pip-version-check install --retries 2 --timeout 30 --no-deps --upgrade --target $dependencies --index-url https://pypi.org/simple @packages
    if ($LASTEXITCODE -ne 0) {
        throw 'MuScriptor installation failed.'
    }
}
& $pythonPath -X utf8 -c "import sys; sys.path.insert(0, sys.argv[1]); import mido; from muscriptor import TranscriptionModel" $dependencies
if ($LASTEXITCODE -ne 0) {
    throw 'MuScriptor could not be loaded.'
}

$weights = $env:HACHIMI_MUSCRIPTOR_MODEL
if (-not $weights) {
    $weights = Join-Path $root 'model.safetensors'
}
$weights = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $weights))
if (-not [IO.File]::Exists($weights) -or -not [IO.File]::Exists([IO.Path]::Combine([IO.Path]::GetDirectoryName($weights), 'config.json'))) {
    Write-Host 'Place the local MuScriptor model.safetensors and its config.json in the project root, or set HACHIMI_MUSCRIPTOR_MODEL.'
}
Write-Host 'MuScriptor is ready. Processing uses the local checkpoint and Windows Python.'
