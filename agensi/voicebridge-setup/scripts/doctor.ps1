<#
.SYNOPSIS
  VoiceBridge doctor for Windows. Read-only.

.DESCRIPTION
  Checks the prerequisites VoiceBridge needs and prints one line per check:
    OK|MISSING|WARN <check> <em dash> <detail>
  When a check fails, the next line starts with "  fix:" and gives the exact
  command or step that fixes it. The script never runs those commands.

  It makes no network calls, installs nothing, writes no files and does not
  need administrator rights. It only reads versions, PATH and the sound
  device list.

  Exit code: 0 if every required check passes, 1 otherwise.

.PARAMETER Path
  Optional path to a VoiceBridge git checkout. Also checks
  desktop\package.json and desktop\node_modules.

.PARAMETER Prebuilt
  The user installs the prebuilt Setup.exe. node, npm and git are only needed
  to build from source, so they are reported as WARN instead of MISSING.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1 -Path C:\src\VoiceBridge
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Path = '',
    [switch]$Prebuilt
)

$ErrorActionPreference = 'Continue'

# Built from its code point so this file stays plain ASCII. Windows
# PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
$Dash = [string][char]0x2014
$script:MissingCount = 0
$script:WarnCount = 0

function Write-Check {
    param(
        [string]$Status,
        [string]$Name,
        [string]$Detail,
        [string]$Fix = ''
    )
    Write-Output ('{0} {1} {2} {3}' -f $Status, $Name, $Dash, $Detail)
    if ($Fix) {
        Write-Output ('  fix: {0}' -f $Fix)
    }
    if ($Status -eq 'MISSING') { $script:MissingCount++ }
    if ($Status -eq 'WARN') { $script:WarnCount++ }
}

# A check that only matters for a source build.
function Write-SourceCheck {
    param(
        [string]$Name,
        [string]$Detail,
        [string]$Fix
    )
    if ($Prebuilt) {
        Write-Check 'WARN' $Name ('{0} (only needed to build from source)' -f $Detail) $Fix
    } else {
        Write-Check 'MISSING' $Name $Detail $Fix
    }
}

function Find-Tool {
    param([string]$Name)
    $cmd = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cmd) { return $cmd.Source }
    return $null
}

# First line a program prints, or '' if it prints nothing or fails to start.
function Get-FirstLine {
    param(
        [string]$Exe,
        [string[]]$Arguments
    )
    try {
        $line = & $Exe @Arguments 2>$null | Select-Object -First 1
        if ($null -ne $line) { return ([string]$line).Trim() }
    } catch {
        return ''
    }
    return ''
}

Write-Output 'VoiceBridge doctor 1.0.0 (read-only)'

# --- Operating system ------------------------------------------------------

if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    Write-Check 'MISSING' 'os' 'this script covers Windows; on macOS and Linux run scripts/doctor.sh' 'bash scripts/doctor.sh'
    exit 1
}

$osCaption = 'Windows'
$osVersion = [System.Environment]::OSVersion.Version.ToString()
try {
    $osInfo = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $osCaption = $osInfo.Caption
    $osVersion = $osInfo.Version
} catch {
    # CIM is unavailable; keep the .NET version string.
    $osCaption = 'Windows'
}
$osDetail = '{0} {1} ({2})' -f $osCaption, $osVersion, $env:PROCESSOR_ARCHITECTURE
if ([System.Environment]::OSVersion.Version.Major -ge 10) {
    Write-Check 'OK' 'os' $osDetail
} else {
    Write-Check 'WARN' 'os' ('{0}; VoiceBridge needs Windows 10 or later' -f $osDetail)
}

$winget = Find-Tool 'winget'
if ($winget) {
    Write-Check 'OK' 'winget' $winget
} else {
    Write-Check 'WARN' 'winget' 'not found; the install commands below need it' 'install App Installer from the Microsoft Store'
}

# --- Source-build tools: node, npm, git --------------------------------------

$nodeFix = 'winget install -e --id OpenJS.NodeJS.LTS'
$node = Find-Tool 'node'
if ($node) {
    $nodeVersion = Get-FirstLine $node @('-v')
    $nodeMajor = 0
    if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
    if ($nodeMajor -ge 18) {
        Write-Check 'OK' 'node' ('{0} at {1} (need 18+)' -f $nodeVersion, $node)
    } else {
        Write-SourceCheck 'node' ('{0} at {1} is too old (need 18+)' -f $nodeVersion, $node) $nodeFix
    }
} else {
    Write-SourceCheck 'node' 'not found (need 18+)' $nodeFix
}

$npm = Find-Tool 'npm'
if ($npm) {
    Write-Check 'OK' 'npm' $npm
} else {
    Write-SourceCheck 'npm' 'not found (it ships with Node.js)' $nodeFix
}

$git = Find-Tool 'git'
if ($git) {
    $gitVersion = (Get-FirstLine $git @('--version')) -replace '^git version ', ''
    Write-Check 'OK' 'git' ('{0} at {1}' -f $gitVersion, $git)
} else {
    Write-SourceCheck 'git' 'not found' 'winget install -e --id Git.Git'
}

# --- Audio tools: ffmpeg, sox, play ----------------------------------------

$ffmpeg = Find-Tool 'ffmpeg'
if ($ffmpeg) {
    $ffmpegVersion = Get-FirstLine $ffmpeg @('-version')
    if ($ffmpegVersion -match '^ffmpeg version (\S+)') { $ffmpegVersion = $Matches[1] } else { $ffmpegVersion = 'found' }
    Write-Check 'OK' 'ffmpeg' ('{0} at {1}' -f $ffmpegVersion, $ffmpeg)
} else {
    Write-Check 'MISSING' 'ffmpeg' 'not found; VoiceBridge uses it to capture the mic and handle audio' 'winget install -e --id Gyan.FFmpeg   (then open a new terminal)'
}

$soxFix = 'winget install -e --id ChrisBagwell.SoX, then add the SoX folder (usually C:\Program Files (x86)\sox-14-4-2) to PATH and open a new terminal'
$sox = Find-Tool 'sox'
if ($sox) {
    $soxVersion = Get-FirstLine $sox @('--version')
    if ($soxVersion -match 'SoX v?([0-9][0-9.]*)') { $soxVersion = 'v' + $Matches[1] } else { $soxVersion = 'found' }
    Write-Check 'OK' 'sox' ('{0} at {1}' -f $soxVersion, $sox)
} else {
    # The winget package does not add SoX to PATH, so look in its default folder.
    $soxDirs = @()
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if ($programFilesX86 -and (Test-Path -LiteralPath $programFilesX86)) {
        $soxDirs = @(Get-ChildItem -LiteralPath $programFilesX86 -Directory -Filter 'sox-*' -ErrorAction SilentlyContinue)
    }
    if ($soxDirs.Count -gt 0) {
        $soxDir = $soxDirs[0].FullName
        Write-Check 'MISSING' 'sox' ('installed in {0} but not on PATH' -f $soxDir) ('add {0} to PATH (System Properties, Environment Variables), then open a new terminal' -f $soxDir)
    } else {
        Write-Check 'MISSING' 'sox' 'not found' $soxFix
    }
}

$ffplay = Find-Tool 'ffplay'
if ($ffplay) {
    Write-Check 'OK' 'ffplay' ('{0}; VoiceBridge streams translated speech through it on Windows' -f $ffplay)
} else {
    Write-Check 'WARN' 'ffplay' 'not found; VoiceBridge falls back to one WAV per utterance through PowerShell (higher delay)' 'winget install -e --id Gyan.FFmpeg   (includes ffplay; then open a new terminal)'
}

# --- Virtual microphone (VB-CABLE) -----------------------------------------

$cableNames = @()
$probeFailures = 0
try {
    $cableNames += @(Get-CimInstance -ClassName Win32_SoundDevice -ErrorAction Stop |
        Where-Object { $_.Name -match 'CABLE|VB-Audio' } |
        ForEach-Object { [string]$_.Name })
} catch {
    $probeFailures++
}
try {
    $cableNames += @(Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction Stop |
        Where-Object { $_.FriendlyName -match 'CABLE' } |
        ForEach-Object { [string]$_.FriendlyName })
} catch {
    $probeFailures++
}
$cableNames = @($cableNames | Where-Object { $_ } | Sort-Object -Unique)

$cableFix = 'download VB-CABLE from https://vb-audio.com/Cable/, extract the ZIP, right-click VBCABLE_Setup_x64.exe, choose Run as administrator, click Install Driver, then restart Windows'
if ($cableNames.Count -gt 0) {
    Write-Check 'OK' 'virtual-mic' ('{0}; meeting apps use CABLE Output as the microphone' -f ($cableNames -join '; '))
} elseif ($probeFailures -ge 2) {
    Write-Check 'MISSING' 'virtual-mic' 'could not read the sound device list (Get-CimInstance and Get-PnpDevice both failed)' 'check Sound settings for CABLE Input and CABLE Output devices; if absent, install VB-CABLE'
} else {
    Write-Check 'MISSING' 'virtual-mic' 'no sound device named CABLE found' $cableFix
}

Write-Check 'WARN' 'playback' 'translated-speech playback on Windows is new in source builds and untested (the 1.0.0 installer has none); route ffplay to CABLE Input in the Volume mixer'

# --- VoiceBridge checkout (optional) ---------------------------------------

if ($Path) {
    $desktopDir = Join-Path $Path 'desktop'
    $pkg = Join-Path $desktopDir 'package.json'
    $modules = Join-Path $desktopDir 'node_modules'
    if (Test-Path -LiteralPath $pkg -PathType Leaf) {
        if (Select-String -LiteralPath $pkg -Pattern '"name"\s*:\s*"voicebridge-desktop"' -Quiet) {
            Write-Check 'OK' 'checkout' ('{0} is voicebridge-desktop' -f $pkg)
        } else {
            Write-Check 'MISSING' 'checkout' ('{0} is not the VoiceBridge desktop app' -f $pkg)
        }
        if (Test-Path -LiteralPath $modules -PathType Container) {
            Write-Check 'OK' 'dependencies' ('{0} exists' -f $modules)
        } else {
            Write-Check 'MISSING' 'dependencies' ('{0} not found' -f $modules) ('cd "{0}"; npm install' -f $desktopDir)
        }
    } elseif (Test-Path -LiteralPath $Path) {
        Write-Check 'MISSING' 'checkout' ('{0} has no desktop\package.json, so it is not a VoiceBridge checkout' -f $Path)
    } else {
        Write-Check 'MISSING' 'checkout' ('{0} does not exist' -f $Path) ('git clone https://github.com/AlleyBo55/VoiceBridge.git "{0}"' -f $Path)
    }
}

# --- Result ------------------------------------------------------------------

Write-Output ''
if ($script:MissingCount -eq 0) {
    Write-Output ('Result: all required checks passed ({0} warning(s)).' -f $script:WarnCount)
    exit 0
}
Write-Output ('Result: {0} required check(s) missing, {1} warning(s). Ask the user before running any fix command.' -f $script:MissingCount, $script:WarnCount)
exit 1
