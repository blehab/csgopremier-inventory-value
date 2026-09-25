<#
.SYNOPSIS
  Bumps the extension version, commits it, tags it and pushes. The tag is what triggers
  .github/workflows/release.yml, which packs the zip and publishes the release that
  update.bat downloads.

.DESCRIPTION
  By default only the version bump is committed, and the script refuses to run if anything
  else is uncommitted - otherwise you would tag a release that does not contain the work you
  just did. Pass -IncludeChanges to fold those changes into the release commit instead.

.EXAMPLE
  .\bump.ps1
  Bumps the patch version, e.g. 1.43.0 -> 1.43.1.

.EXAMPLE
  .\bump.ps1 minor -IncludeChanges
  Bumps to 1.44.0, committing everything currently modified along with it.

.EXAMPLE
  .\bump.ps1 -Version 2.0.0 -NoPush
  Sets an exact version and tags locally without pushing.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Part = 'patch',

  # Exact version, e.g. 2.0.0. Takes precedence over $Part.
  [string]$Version,

  # Commit every pending change along with the bump, not just manifest.json.
  [switch]$IncludeChanges,

  # Commit and tag locally, but do not push (so no release is built).
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
  $output = & git @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed:`n$($output -join "`n")"
  }
  $output
}

$null = Invoke-Git rev-parse --is-inside-work-tree

$branch = (Invoke-Git rev-parse --abbrev-ref HEAD) | Select-Object -First 1
if ($branch -ne 'main') {
  Write-Host "Note: you are on '$branch', not main. The release workflow runs off the tag, so this still works." -ForegroundColor Yellow
}

$manifestPath = Join-Path $PSScriptRoot 'manifest.json'
$manifest = Get-Content $manifestPath -Raw
$match = [regex]::Match($manifest, '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"')
if (-not $match.Success) { throw "No semver version found in $manifestPath" }
$current = "$($match.Groups[1].Value).$($match.Groups[2].Value).$($match.Groups[3].Value)"

# Anything modified besides manifest.json would be left out of the tagged release.
$pending = @(Invoke-Git status --porcelain | Where-Object { $_ -and ($_.Substring(3) -ne 'manifest.json') })
if ($pending.Count -and -not $IncludeChanges) {
  Write-Host 'Uncommitted changes that would not make it into the release:' -ForegroundColor Red
  $pending | ForEach-Object { Write-Host "  $_" }
  Write-Host ''
  Write-Host 'Commit them first, or re-run with -IncludeChanges to bundle them into the release commit.'
  exit 1
}

if ($Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.44.0, got '$Version'" }
  $new = $Version
}
else {
  $major = [int]$match.Groups[1].Value
  $minor = [int]$match.Groups[2].Value
  $patch = [int]$match.Groups[3].Value
  switch ($Part) {
    'major' { $new = "$($major + 1).0.0" }
    'minor' { $new = "$major.$($minor + 1).0" }
    'patch' { $new = "$major.$minor.$($patch + 1)" }
  }
}

if ([version]$new -le [version]$current) {
  throw "New version $new is not greater than the current $current."
}

$tag = "v$new"
if (Invoke-Git tag --list $tag) { throw "Tag $tag already exists locally." }
if (-not $NoPush -and (Invoke-Git ls-remote --tags origin "refs/tags/$tag")) {
  throw "Tag $tag already exists on origin."
}

# Replace just the version value so the file's formatting is untouched.
$updated = $manifest.Remove($match.Index, $match.Length).Insert($match.Index, """version"": ""$new""")
[System.IO.File]::WriteAllText($manifestPath, $updated)
try { $null = $updated | ConvertFrom-Json }
catch {
  [System.IO.File]::WriteAllText($manifestPath, $manifest)
  throw "The bump produced invalid JSON; manifest.json was restored. $_"
}

Write-Host "$current -> $new" -ForegroundColor Cyan

if ($IncludeChanges) { $null = Invoke-Git add -A } else { $null = Invoke-Git add -- manifest.json }
$null = Invoke-Git commit -m "Release $tag"
$null = Invoke-Git tag $tag

if ($NoPush) {
  Write-Host ''
  Write-Host "Committed and tagged $tag locally. Push it when you are ready:" -ForegroundColor Green
  Write-Host "  git push origin HEAD $tag"
  return
}

$null = Invoke-Git push origin HEAD
$null = Invoke-Git push origin $tag

Write-Host ''
Write-Host "Pushed $tag. The release is building:" -ForegroundColor Green
Write-Host '  gh run watch'
Write-Host ''
Write-Host 'Once it finishes, update.bat will pick it up.'
