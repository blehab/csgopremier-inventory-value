# CSGOPremier Inventory Value - setup, run by update.bat after every install or update.
#
# Lets csgopremier.com open steam:// links without Chrome's "Open Steam?" prompt, so the extension's
# "Join game" button (join-game.js) goes straight to Steam. That's Chrome's AutoLaunchProtocolsFromOrigins
# policy, written for the current user only (HKCU, no admin needed):
#     HKCU\Software\Policies\Google\Chrome\AutoLaunchProtocolsFromOrigins
#       = [{"protocol":"steam","allowed_origins":["https://csgopremier.com"]}]
# Entries already in that policy for other protocols or sites are kept. Running it again changes nothing.
# Chrome picks the policy up by itself within a minute or so (or press "Reload policies" in
# chrome://policy), and it shows there as a user policy. Chrome then also says it's "managed by your
# organization"; that's just because a policy is set.
#
# Undo:  .\setup.ps1 -Remove   (takes out only this entry)

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$Key = 'HKCU:\Software\Policies\Google\Chrome'
$Name = 'AutoLaunchProtocolsFromOrigins'
$Protocol = 'steam'
$Origin = 'https://csgopremier.com'

# The current entries, as a list of { protocol, allowed_origins }. Anything unreadable counts as none.
$entries = @()
$current = (Get-ItemProperty -Path $Key -Name $Name -ErrorAction SilentlyContinue).$Name
if ($current) {
  try { $entries = @(ConvertFrom-Json $current) } catch { Write-Host "  Existing $Name value isn't valid JSON; replacing it." }
}

# Take this origin out of the steam entry (dropping the entry if nothing else is left in it).
$others = @()
foreach ($e in $entries) {
  if ($e.protocol -eq $Protocol) {
    $rest = @($e.allowed_origins | Where-Object { $_ -ne $Origin })
    if ($rest.Count) { $others += [pscustomobject]@{ protocol = $Protocol; allowed_origins = $rest } }
  } else {
    $others += $e
  }
}

if ($Remove) {
  $new = $others
} else {
  $steam = $others | Where-Object { $_.protocol -eq $Protocol } | Select-Object -First 1
  if ($steam) {
    $steam.allowed_origins = @($steam.allowed_origins) + $Origin
    $new = $others
  } else {
    $new = @($others) + [pscustomobject]@{ protocol = $Protocol; allowed_origins = @($Origin) }
  }
}

# ConvertTo-Json turns a one-element array into a bare object, so build the list's brackets here.
$json = '[' + (($new | ForEach-Object { ConvertTo-Json $_ -Compress -Depth 3 }) -join ',') + ']'
$json = $json -replace '"allowed_origins":"([^"]*)"', '"allowed_origins":["$1"]' # a single origin, same problem

if (-not $new.Count) {
  if ($current) { Remove-ItemProperty -Path $Key -Name $Name }
} elseif ($json -ne $current) {
  if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null } # -Force on an existing key would wipe its other policies
  Set-ItemProperty -Path $Key -Name $Name -Value $json -Type String
} elseif (-not $Remove) {
  Write-Host "  Steam links from csgopremier.com already open without a prompt."
  exit 0
}

if ($Remove) { Write-Host "  Chrome will ask again before csgopremier.com opens Steam." }
else { Write-Host "  Chrome will now let csgopremier.com open Steam without asking (see chrome://policy)." }
