# Build-time preparation only. Never installs or launches the redistributable.
[CmdletBinding()]
param(
    [string]$OutputDirectory = '',
    [string]$PythonPath = '',
    [switch]$ForceDownload
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $PSScriptRoot 'vc-runtime-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$nsisSource = Get-Content -LiteralPath (Join-Path $projectRoot 'frontend/installer/prerequisites.nsh') -Raw
$nsisVersion = [regex]::Match($nsisSource, '(?m)^!define STEM_VC_VERSION "([0-9.]+)"').Groups[1].Value
if ($nsisVersion -ne $manifest.version) {
    throw 'NSIS prerequisite version must match vc-runtime-manifest.json.'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot 'frontend/build-resources/prerequisites'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$destination = Join-Path $OutputDirectory 'vc_redist.x64.exe'
$partial = Join-Path $OutputDirectory 'vc_redist.x64.exe.partial'

$downloadUri = [Uri]$manifest.url
if ($downloadUri.Scheme -ne 'https' -or $downloadUri.Host -ne 'download.visualstudio.microsoft.com') {
    throw 'VC++ runtime manifest must point to the official Microsoft HTTPS download host.'
}

function Test-VcRuntimeArtifact([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $artifact = Get-Item -LiteralPath $Path
    if ($artifact.Length -ne [long]$manifest.bytes) { return $false }
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($hash -ine $manifest.sha256) { return $false }
    if ($artifact.VersionInfo.FileVersion -ne $manifest.version) {
        throw "VC++ runtime version differs from the pinned manifest: $($artifact.VersionInfo.FileVersion)"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
        throw "Microsoft VC++ runtime Authenticode signature is not valid: $($signature.Status)"
    }
    if ($signature.SignerCertificate.Subject -ne $manifest.signerSubject -or
        $signature.SignerCertificate.Thumbprint -ine $manifest.signerThumbprint) {
        throw 'VC++ runtime signer differs from the pinned Microsoft certificate.'
    }
    return $true
}

if ($ForceDownload -or -not (Test-VcRuntimeArtifact $destination)) {
    # Prepared CPython uses its normal verified HTTPS implementation. This also
    # works in build hosts where Windows Schannel credentials are unavailable.
    # No certificate checks or TLS protections are disabled in either path.
    if ([string]::IsNullOrWhiteSpace($PythonPath)) {
        $preparedPython = Join-Path $projectRoot 'frontend/build-resources/runtime/python/python.exe'
        if (Test-Path -LiteralPath $preparedPython -PathType Leaf) { $PythonPath = $preparedPython }
    }
    Write-Host "Downloading official Microsoft VC++ x64 runtime $($manifest.version)..."
    try {
        if (-not [string]::IsNullOrWhiteSpace($PythonPath)) {
            $downloadCode = @'
import pathlib, shutil, sys, urllib.parse, urllib.request
url, target = sys.argv[1:3]
request = urllib.request.Request(url, headers={"User-Agent": "StemStudio-Builder"})
with urllib.request.urlopen(request, timeout=90) as response:
    final = urllib.parse.urlparse(response.geturl())
    if final.scheme != "https" or final.hostname != "download.visualstudio.microsoft.com":
        raise RuntimeError("Unexpected Microsoft runtime download redirect")
    with pathlib.Path(target).open("wb") as output:
        shutil.copyfileobj(response, output)
'@
            & $PythonPath -c $downloadCode $manifest.url $partial
            if ($LASTEXITCODE -ne 0) { throw "VC++ runtime download failed (Python exit $LASTEXITCODE)." }
        }
        else {
            # Windows PowerShell fallback when Python preparation has not run.
            Invoke-WebRequest -Uri $manifest.url -OutFile $partial -UseBasicParsing
        }
        if (-not (Test-VcRuntimeArtifact $partial)) {
            throw 'VC++ runtime size or SHA-256 did not match the pinned official artifact.'
        }
        Move-Item -LiteralPath $partial -Destination $destination -Force
    }
    finally {
        if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial -Force }
    }
}

# Build receipts are shipped alongside the installer source and remain readable.
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $OutputDirectory 'vc-runtime-manifest.json') -Force
Write-Host "Verified official Microsoft installer: $destination"
Write-Host "Version $($manifest.version); SHA-256 $($manifest.sha256); Microsoft signature valid."
