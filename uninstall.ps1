# Remove Bookwyrm from this Windows computer.
#
#   & "$env:USERPROFILE\bookwyrm\uninstall.ps1"            lists what it will remove, then asks
#   & "$env:USERPROFILE\bookwyrm\uninstall.ps1" --dry-run  only lists it
#   & "$env:USERPROFILE\bookwyrm\uninstall.ps1" --yes      doesn't ask
#
# Runs the setup wizard's --uninstall with the Node.js the installer fetched (or yours).
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = $null
$candidates = @(Get-ChildItem -Path (Join-Path $env:USERPROFILE '.bookwyrm\node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$onPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($onPath) { $candidates += $onPath.Source }
foreach ($c in $candidates) {
    & $c -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)" 2>$null
    if ($LASTEXITCODE -eq 0) { $node = $c; break }
}
if (-not $node) {
    Write-Host "Couldn't find Node.js 22.12 or newer, which the uninstaller runs on."
    Write-Host "Remove Bookwyrm by hand instead: see 'Removing Bookwyrm' in $dir\docs\setup.md"
    exit 1
}
& $node (Join-Path $dir 'setup\dist\setup.mjs') --uninstall @args
exit $LASTEXITCODE
