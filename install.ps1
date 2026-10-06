# Bookwyrm installer for Windows 10/11 (Windows PowerShell 5.1 or PowerShell 7).
#
#   irm https://raw.githubusercontent.com/dfirmin/bookwyrm/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/dfirmin/bookwyrm/main/install.ps1))) --yes --repo owner/name
#   .\install.ps1 [options]                      (from a clone)
#
# Gets Node.js 22 if needed (into %USERPROFILE%\.bookwyrm\node, checksum-verified), gets or
# updates the Bookwyrm source (%USERPROFILE%\bookwyrm, or $env:BOOKWYRM_DIR), then starts the
# setup wizard in setup\. Options are passed to the wizard. Safe to run again.
#
# Under `irm | iex` this runs inside your PowerShell window, so it never calls `exit` (that would
# close the window) and puts PATH and settings back the way they were when it finishes.

function Install-Bookwyrm {
    param([string]$ScriptDir = '')

    $ErrorActionPreference = 'Stop'
    $RepoUrl = 'https://github.com/dfirmin/bookwyrm'
    $Branch = if ($env:BOOKWYRM_BRANCH) { $env:BOOKWYRM_BRANCH } else { 'main' }
    $BwHome = Join-Path $env:USERPROFILE '.bookwyrm'

    # Windows PowerShell 5.1 may not offer TLS 1.2 by default; its progress bar makes downloads crawl.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'

    function Test-NodeOk([string]$Path) {
        if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
        # 'Continue' so a stray stderr line from an old node can't turn into a terminating error.
        $ErrorActionPreference = 'Continue'
        try { $v = & $Path -p 'process.versions.node' } catch { return $false }
        if ($LASTEXITCODE -ne 0 -or -not $v) { return $false }
        $parts = "$v".Trim().Split('.')
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
        return ($major -gt 22) -or ($major -eq 22 -and $minor -ge 12)
    }

    function Get-PortableNode {
        $arch = $env:PROCESSOR_ARCHITECTURE
        if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
        if ($arch -eq 'ARM64') { $plat = 'win-arm64' }
        elseif ($arch -eq 'AMD64') { $plat = 'win-x64' }
        else { throw "There is no Node.js 22 build for this processor ($arch). Install Node.js 22 yourself and run this again." }

        # BOOKWYRM_NODE_MIRROR: a company mirror of https://nodejs.org/dist/latest-v22.x, if you have one.
        $base = if ($env:BOOKWYRM_NODE_MIRROR) { $env:BOOKWYRM_NODE_MIRROR.TrimEnd('/') } else { 'https://nodejs.org/dist/latest-v22.x' }
        # Unpack next to the destination: Move-Item can't move folders between drives.
        $tmp = Join-Path $BwHome ('.node-download-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        try {
            Write-Host "Getting Node.js 22 for $plat (about 30 MB)..."
            $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
            if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
            $line = $sums -split "`n" | Where-Object { $_ -match "^[0-9a-f]{64}\s+node-v22\.\d+\.\d+-$plat\.zip\s*$" } | Select-Object -First 1
            if (-not $line) { throw "$base has no Node.js 22 build for $plat." }
            $want = ($line -split '\s+')[0]
            $file = ($line.Trim() -split '\s+')[1]
            $zip = Join-Path $tmp $file
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $zip
            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
            if ($got -ne $want) { throw "The Node.js download didn't match its checksum; try again." }
            Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
            $unpacked = Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($file))
            $dest = Join-Path $BwHome 'node'
            if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
            Move-Item -LiteralPath $unpacked -Destination $dest
        } finally {
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Host "Node.js is in $dest"
    }

    # ---- Node.js ----------------------------------------------------------------------------------
    $node = $null
    $onPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $portable = Join-Path $BwHome 'node\node.exe'
    if ($onPath -and (Test-NodeOk $onPath.Path)) { $node = $onPath.Path }
    elseif (Test-NodeOk $portable) { $node = $portable }
    else {
        Get-PortableNode
        if (-not (Test-NodeOk $portable)) { throw "The downloaded Node.js doesn't run on this computer." }
        $node = $portable
    }
    $nodeDir = Split-Path -Parent $node

    # ---- Bookwyrm source --------------------------------------------------------------------------
    function Test-Bookwyrm([string]$Dir) {
        return (Test-Path -LiteralPath (Join-Path $Dir 'setup\package.json')) -and (Test-Path -LiteralPath (Join-Path $Dir 'profile\config.yaml'))
    }
    $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

    function Get-SourceZip([string]$Dir) {
        Write-Host 'Downloading Bookwyrm...'
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('bookwyrm-src-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        try {
            $zip = Join-Path $tmp 'bookwyrm.zip'
            Invoke-WebRequest -UseBasicParsing -Uri "$RepoUrl/archive/refs/heads/$Branch.zip" -OutFile $zip
            Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
            $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
            New-Item -ItemType Directory -Force -Path $Dir | Out-Null
            # Copy over what's there, keeping voice\.venv, app\node_modules and the like.
            Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $Dir -Recurse -Force
        } finally {
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if ($ScriptDir -and (Test-Bookwyrm $ScriptDir) -and -not $env:BOOKWYRM_DIR) {
        $dir = $ScriptDir
    } else {
        $dir = if ($env:BOOKWYRM_DIR) { $env:BOOKWYRM_DIR } else { Join-Path $env:USERPROFILE 'bookwyrm' }
        if ((Test-Path -LiteralPath (Join-Path $dir '.git')) -and (Test-Bookwyrm $dir)) {
            Write-Host "Updating Bookwyrm in $dir..."
            $updated = $false
            if ($git) {
                & $git.Path -C $dir pull --ff-only --quiet | Out-Host
                $updated = ($LASTEXITCODE -eq 0)
            }
            if (-not $updated) { Write-Host "(Couldn't update it automatically; carrying on with the copy that's there.)" }
        } elseif (Test-Bookwyrm $dir) {
            Get-SourceZip $dir
        } elseif ((Test-Path -LiteralPath $dir) -and (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)) {
            throw "$dir already exists and isn't Bookwyrm. Set `$env:BOOKWYRM_DIR to another folder and run this again."
        } elseif ($git) {
            Write-Host "Getting Bookwyrm into $dir..."
            & $git.Path clone --quiet --branch $Branch "$RepoUrl.git" $dir | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
        } else {
            Get-SourceZip $dir
        }
    }
    if (-not (Test-Bookwyrm $dir)) { throw "$dir doesn't look like Bookwyrm." }

    # ---- the wizard -------------------------------------------------------------------------------
    $setupDir = Join-Path $dir 'setup'
    $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli)) { throw "npm wasn't found next to $node." }

    Push-Location $setupDir
    try {
        $lock = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $setupDir 'package-lock.json')).Hash.ToLowerInvariant()
        $stamp = Join-Path $setupDir 'node_modules\.bookwyrm-installed'
        $installed = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { '' }
        if ($installed -ne $lock) {
            Write-Host 'Preparing the setup wizard...'
            & $node $npmCli ci --no-audit --no-fund --loglevel=error | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Couldn't install the setup wizard (npm ci in $setupDir)." }
            [IO.File]::WriteAllText($stamp, $lock)
        } else {
            & $node $npmCli run build --silent | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Couldn't build the setup wizard." }
        }
    } finally {
        Pop-Location
    }
    return @{ Node = $node; NodeDir = $nodeDir; Wizard = (Join-Path $setupDir 'dist\setup.mjs') }
}

# Script entry. $PSScriptRoot is empty under `irm | iex`; then there is no clone to use.
# The wizard runs here at the top, not inside the function, so it talks to the console directly
# (output captured by a function would hide the wizard and make it think there's no terminal).
$__bwSavedPath = $env:Path
$__bwSavedProgress = $ProgressPreference
$__bwSavedEap = $ErrorActionPreference
try {
    $__bw = @(Install-Bookwyrm -ScriptDir $PSScriptRoot)[-1]
    $env:Path = "$($__bw.NodeDir);$env:Path"
    $ErrorActionPreference = 'Continue'
    & $__bw.Node $__bw.Wizard @args
    if ($LASTEXITCODE) { Write-Host "Setup finished with exit code $LASTEXITCODE." }
} catch {
    Write-Host ''
    Write-Host "Bookwyrm setup stopped: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    $env:Path = $__bwSavedPath
    $ProgressPreference = $__bwSavedProgress
    $ErrorActionPreference = $__bwSavedEap
    Remove-Variable -Name __bw, __bwSavedPath, __bwSavedProgress, __bwSavedEap -ErrorAction SilentlyContinue
    Remove-Item -Path Function:\Install-Bookwyrm -ErrorAction SilentlyContinue
}
