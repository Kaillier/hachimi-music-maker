$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$site = Join-Path $root 'website'
if (-not (Test-Path (Join-Path $site 'assets/catalog.json'))) {
    throw 'Audio pack is missing. Run backend/experiments/prepare_web.py in the existing WSL audio environment first.'
}
if (-not (Test-Path (Join-Path $site 'vendor/lucide.js'))) {
    Push-Location $site
    try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Website build failed.' }
    } finally { Pop-Location }
}
$logDirectory = Join-Path $root 'backend/runtime/web-server'
New-Item -ItemType Directory -Force $logDirectory | Out-Null
$id = [guid]::NewGuid().ToString('N')
$log = Join-Path $logDirectory "$id.log"
$errorLog = Join-Path $logDirectory "$id.error.log"
$node = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process -FilePath $node -ArgumentList 'website/serve.mjs','4174' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errorLog -PassThru
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) { throw (Get-Content -LiteralPath $errorLog -Raw) }
    $text = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
    if ($text -match 'http://127\.0\.0\.1:\d+') {
        $url = $Matches[0]
        Start-Process $url
        Write-Host "Hachimi is running at $url (process $($process.Id))"
        exit 0
    }
}
throw 'The local server did not start in time.'
