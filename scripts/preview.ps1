<#
.SYNOPSIS
  Serve the site locally so changes can be checked before they are deployed.

.DESCRIPTION
  The live site is password-gated and `data.json` sits at the repo root while the
  page is served from `public/`, so opening `public/index.html` directly does not
  work -- app.js fetches `/data.json` and gets a 404.

  This stages the static assets of `public/` and an INVENTED data.json into one
  directory and serves it statically, with no password and no server.js, bound
  to 127.0.0.1 only. It is a rendering check only: the auth and security
  behaviour of the real server is NOT exercised here.

  It never stages the canonical data.json or any published JSON aggregate
  (public/periods.json and the like): the server is unauthenticated, so it
  serves only the synthetic household from test/fixtures. Previewing real
  household data locally is out of scope; ask the owner.

  Verify before pushing. A change that breaks the page is invisible in a diff.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\preview.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 8899,
    [string]$StageDir = (Join-Path $env:TEMP 'atlas-preview')
)

$ErrorActionPreference = 'Stop'

function Get-ProjectRoot {
    $common = & git rev-parse --path-format=absolute --git-common-dir 2>$null
    if ($LASTEXITCODE -eq 0 -and $common) {
        return (Split-Path -Parent ($common -replace '/', '\').TrimEnd('\'))
    }
    return (Split-Path -Parent $PSScriptRoot)
}

# Serve the working tree being edited, not the main checkout -- otherwise this
# previews whatever was last merged rather than the change under review.
$src = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $src 'public'))) { $src = Get-ProjectRoot }

$publicDir = Join-Path $src 'public'
$syntheticData = Join-Path $src 'scripts\preview-synthetic-data.js'
foreach ($p in @($publicDir, $syntheticData)) {
    if (-not (Test-Path $p)) { throw "Not found: $p" }
}

# Static assets only. No .json file is ever copied: public/ holds published
# household aggregates (periods.json) and this server has no password.
$StaticExtensions = @('.html', '.js', '.css', '.woff2', '.png', '.svg', '.ico', '.webmanifest')

# The stage is a throwaway copy that gets emptied. Never inside the repository,
# where the canonical data.json and the public/ aggregates live.
# Resolve against PowerShell's current location, as New-Item and Remove-Item do.
$StageDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StageDir)
$stageFull = [System.IO.Path]::GetFullPath($StageDir).TrimEnd('\', '/')
$srcFull = [System.IO.Path]::GetFullPath($src).TrimEnd('\', '/')
if ($stageFull -eq $srcFull -or $stageFull.StartsWith($srcFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stage the preview inside the repository: $stageFull"
}

# Only ever empty a directory this script made: a new or empty one, or one
# carrying the stage marker. Any other existing folder is refused untouched.
$StageMarker = '.atlas-preview-stage'
if ((Test-Path $StageDir) -and -not (Test-Path (Join-Path $StageDir $StageMarker))) {
    if (Get-ChildItem $StageDir -Force | Select-Object -First 1) {
        throw ("Refusing to empty $StageDir`: it is not an Atlas preview stage (no $StageMarker). " +
            'If an older version of this script made it, delete it yourself: it may hold household data.')
    }
}

New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $StageDir $StageMarker) -Force | Out-Null
Get-ChildItem $StageDir -File | Where-Object { $_.Name -ne $StageMarker } | Remove-Item -Force
# Belt and braces: no JSON survives in a reused stage.
Get-ChildItem $StageDir -File -Recurse -Filter '*.json' | Remove-Item -Force

# The only data.json staged is the invented household (the helper refuses an
# in-repository stage too). Fail loudly here rather than as a blank page.
& node $syntheticData $StageDir
if ($LASTEXITCODE -ne 0) { throw 'could not stage the synthetic preview data' }

foreach ($f in Get-ChildItem $publicDir -File -Recurse) {
    if ($StaticExtensions -notcontains $f.Extension.ToLowerInvariant()) { continue }
    $rel = $f.FullName.Substring($publicDir.Length).TrimStart('\', '/')
    $dest = Join-Path $StageDir $rel
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    Copy-Item $f.FullName -Destination $dest -Force
}

foreach ($js in Get-ChildItem $publicDir -Filter '*.js') {
    & node --check $js.FullName
    if ($LASTEXITCODE -ne 0) { throw "public/$($js.Name) has a syntax error" }
}

Write-Host "Serving $src"
Write-Host "  staged to $StageDir"
Write-Host "  http://127.0.0.1:$Port  (synthetic household, this machine only)"
Write-Host ''
Write-Host 'Rendering check only -- password and security behaviour are not exercised.'
Write-Host ''

& npx --yes http-server $StageDir -a 127.0.0.1 -p $Port -c-1
