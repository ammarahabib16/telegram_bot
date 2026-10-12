param(
    [string]$ProfileName = "ammara",
    [int]$Port = 9333,
    [switch]$Sync
)

$chromePath = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chromePath)) {
    $chromePath = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $chromePath)) {
    $chromePath = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $chromePath)) {
    Write-Error "Google Chrome not found."
    exit 1
}

$userDataDir = "$env:LOCALAPPDATA\Google\Chrome\User Data"
$localState = Join-Path $userDataDir "Local State"
if (-not (Test-Path $localState)) {
    Write-Error "Chrome Local State not found at $localState"
    exit 1
}

$profiles = (Get-Content $localState -Raw | ConvertFrom-Json).profile.info_cache
$profileDir = $null
foreach ($key in $profiles.PSObject.Properties.Name) {
    if ($profiles.$key.name -ieq $ProfileName) {
        $profileDir = $key
        break
    }
}
if (-not $profileDir) {
    Write-Error "No Chrome profile named '$ProfileName' found. Available: $($profiles.PSObject.Properties.Name -join ', ')"
    exit 1
}

$debugDir = Join-Path $PSScriptRoot "ammara-profile"

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    try {
        $ver = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
        Write-Host "Debug Chrome already running ($($ver.Browser)) on port $Port."
        Write-Host "CDP endpoint: http://127.0.0.1:$Port"
        exit 0
    } catch {
        Write-Error "Port $Port is in use by another process. Use -Port <other> or stop that process."
        exit 1
    }
}

$needsSync = $Sync -or
    -not (Test-Path (Join-Path $debugDir "Local State")) -or
    -not (Test-Path (Join-Path $debugDir $profileDir))

if ($needsSync) {
    $realChrome = @(Get-Process chrome -ErrorAction SilentlyContinue)
    if ($realChrome.Count -gt 0) {
        Write-Error "Close all Chrome windows first so the profile copy is consistent, then re-run. (This is only needed once, or when you pass -Sync.)"
        exit 1
    }

    Write-Host "Syncing profile '$ProfileName' ($profileDir) -> $debugDir ..."
    if (-not (Test-Path $debugDir)) {
        New-Item -ItemType Directory -Path $debugDir | Out-Null
    }

    robocopy $userDataDir $debugDir "Local State" "Last Version" /R:1 /W:1 /NP /NFL /NDL /NJH | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Write-Error "robocopy failed for root files (exit $LASTEXITCODE)"
        exit 1
    }

    $excludeDirs = @(
        "Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache",
        "DawnCache", "Service Worker", "File System", "Crashpad",
        "component_crx_cache", "BrowserMetrics", "blob_storage"
    )
    robocopy (Join-Path $userDataDir $profileDir) (Join-Path $debugDir $profileDir) `
        /E /MIR /XD $excludeDirs /R:1 /W:1 /NP /NFL /NDL /NJH /MT:8 | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Write-Error "robocopy failed for profile (exit $LASTEXITCODE)"
        exit 1
    }
    Write-Host "Profile sync complete (caches excluded)."
}

Write-Host "Starting Chrome profile '$ProfileName' from $debugDir on port $Port..."
Start-Process $chromePath -ArgumentList @(
    "--user-data-dir=`"$debugDir`"",
    "--profile-directory=`"$profileDir`"",
    "--remote-debugging-port=$Port",
    "--no-first-run",
    "--no-default-browser-check",
    "https://chat.deepseek.com/"
)

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $ver = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        Write-Host "Chrome is ready."
        Write-Host "Browser:     $($ver.Browser)"
        Write-Host "CDP endpoint: http://127.0.0.1:$Port"
        exit 0
    } catch {}
}

Write-Error "Chrome did not expose the debug port on $Port within 15 seconds."
exit 1
