#!/usr/bin/env bash
# VoiceBridge doctor for macOS and Linux.
#
# Read-only: it makes no network calls, installs nothing, writes no files and
# never uses sudo. It only reads versions, PATH and the audio device list.
#
# Usage: bash doctor.sh [--prebuilt] [PATH_TO_VOICEBRIDGE_CHECKOUT]
#
#   --prebuilt  The user installs a prebuilt release. node, npm and git are
#               only needed to build from source, so they are reported as
#               WARN instead of MISSING.
#   PATH        A VoiceBridge git checkout. Also checks desktop/package.json
#               and desktop/node_modules.
#
# Output: one line per check, "OK|MISSING|WARN <check> — <detail>". When a
# check fails, the next line starts with "  fix:" and gives the exact command
# that fixes it. The script never runs those commands.
#
# Exit status: 0 if every required check passes, 1 otherwise, 2 on bad usage.

set -u

DOCTOR_VERSION="1.0.0"
PREBUILT=0
CHECKOUT=""

print_usage() {
  cat <<'EOF'
Usage: bash doctor.sh [--prebuilt] [PATH_TO_VOICEBRIDGE_CHECKOUT]
  --prebuilt  treat node, npm and git as optional (prebuilt installer)
  PATH        also check a VoiceBridge checkout (desktop/package.json, desktop/node_modules)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prebuilt) PREBUILT=1 ;;
    -h|--help) print_usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; print_usage >&2; exit 2 ;;
    *)
      if [ -n "$CHECKOUT" ]; then
        echo "Only one checkout path is allowed." >&2
        exit 2
      fi
      CHECKOUT="$1"
      ;;
  esac
  shift
done

MISSING_COUNT=0
WARN_COUNT=0

# report STATUS CHECK DETAIL [FIX]
report() {
  printf '%s %s — %s\n' "$1" "$2" "$3"
  if [ -n "${4:-}" ]; then
    printf '  fix: %s\n' "$4"
  fi
  case "$1" in
    MISSING) MISSING_COUNT=$((MISSING_COUNT + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
  esac
}

# report_source_tool CHECK DETAIL FIX: a check that only matters for a source build.
report_source_tool() {
  if [ "$PREBUILT" -eq 1 ]; then
    report WARN "$1" "$2 (only needed to build from source)" "$3"
  else
    report MISSING "$1" "$2" "$3"
  fi
}

# VoiceBridge prepends these folders to its own PATH, so tools there are found
# even when the app is started from Finder, the Dock or an app menu.
APP_EXTRA_PATHS="/opt/homebrew/bin /usr/local/bin /usr/bin /snap/bin /home/linuxbrew/.linuxbrew/bin"

# find_tool NAME: print the path of NAME from PATH or from APP_EXTRA_PATHS.
find_tool() {
  if command -v "$1" >/dev/null 2>&1; then
    command -v "$1"
    return 0
  fi
  for dir in $APP_EXTRA_PATHS; do
    if [ -x "$dir/$1" ]; then
      printf '%s\n' "$dir/$1"
      return 0
    fi
  done
  return 1
}

# path_note NAME: explain a tool that was found outside this shell's PATH.
path_note() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf ' (not on this shell PATH, but VoiceBridge searches that folder)'
  fi
}

echo "VoiceBridge doctor $DOCTOR_VERSION (read-only)"

# ── Operating system ────────────────────────────────────────

PLATFORM="other"
PM=""
KERNEL="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

case "$KERNEL" in
  Darwin)
    PLATFORM="macos"
    MAC_VERSION="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
    MAC_MAJOR="${MAC_VERSION%%.*}"
    case "$MAC_MAJOR" in ''|*[!0-9]*) MAC_MAJOR=0 ;; esac
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
      CHIP="Apple Silicon"
    else
      CHIP="Intel"
    fi
    if [ "$MAC_MAJOR" -ge 12 ]; then
      report OK os "macOS $MAC_VERSION, $CHIP ($ARCH)"
    else
      report WARN os "macOS $MAC_VERSION, $CHIP ($ARCH); VoiceBridge needs macOS 12 or later"
    fi
    ;;
  Linux)
    PLATFORM="linux"
    DISTRO=""
    if [ -r /etc/os-release ]; then
      DISTRO="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '"')"
    fi
    report OK os "${DISTRO:-Linux} ($ARCH)"
    if command -v apt-get >/dev/null 2>&1; then
      PM="apt"
    elif command -v dnf >/dev/null 2>&1; then
      PM="dnf"
    elif command -v pacman >/dev/null 2>&1; then
      PM="pacman"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    report MISSING os "this is a Windows shell; this script covers macOS and Linux" "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\doctor.ps1"
    exit 1
    ;;
  *)
    report MISSING os "$KERNEL is not supported; VoiceBridge runs on macOS, Linux and Windows"
    exit 1
    ;;
esac

# fix_cmd KEY: the exact command that installs KEY on this machine.
fix_cmd() {
  case "$PLATFORM:$PM:$1" in
    macos:*:brew)   echo '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' ;;
    macos:*:node)   echo 'brew install node' ;;
    macos:*:git)    echo 'xcode-select --install   (or: brew install git)' ;;
    macos:*:ffmpeg) echo 'brew install ffmpeg' ;;
    macos:*:sox)    echo 'brew install sox' ;;
    macos:*:vmic)   echo 'brew install --cask blackhole-2ch   (asks for the macOS password; restart the Mac afterwards)' ;;
    linux:apt:node)   echo 'sudo apt install -y nodejs npm   (Node 18+ on Ubuntu 24.04+ and Debian 12+; on older releases use https://nodejs.org/en/download)' ;;
    linux:apt:git)    echo 'sudo apt install -y git' ;;
    linux:apt:ffmpeg) echo 'sudo apt install -y ffmpeg' ;;
    linux:apt:sox)    echo 'sudo apt install -y sox libsox-fmt-all' ;;
    linux:apt:pactl)  echo 'sudo apt install -y pulseaudio-utils' ;;
    linux:dnf:node)   echo 'sudo dnf install -y nodejs npm' ;;
    linux:dnf:git)    echo 'sudo dnf install -y git' ;;
    linux:dnf:ffmpeg) echo 'sudo dnf install -y ffmpeg-free' ;;
    linux:dnf:sox)    echo 'sudo dnf install -y sox' ;;
    linux:dnf:pactl)  echo 'sudo dnf install -y pulseaudio-utils' ;;
    linux:pacman:node)   echo 'sudo pacman -S --needed nodejs npm' ;;
    linux:pacman:git)    echo 'sudo pacman -S --needed git' ;;
    linux:pacman:ffmpeg) echo 'sudo pacman -S --needed ffmpeg' ;;
    linux:pacman:sox)    echo 'sudo pacman -S --needed sox' ;;
    linux:pacman:pactl)  echo 'sudo pacman -S --needed libpulse' ;;
    linux:*:vmic) echo 'pactl load-module module-null-sink sink_name=voicebridge sink_properties=device.description="VoiceBridge\ Mic"   (no sudo; or click Install Driver in VoiceBridge)' ;;
    linux:*:*)    echo "install $1 with your distribution's package manager" ;;
    *)            echo "install $1" ;;
  esac
}

# ── Homebrew (macOS) ────────────────────────────────────────

if [ "$PLATFORM" = "macos" ]; then
  BREW_BIN="$(find_tool brew)"
  if [ -z "$BREW_BIN" ]; then
    report WARN homebrew "not found; the macOS install commands below need it" "$(fix_cmd brew)"
  elif command -v brew >/dev/null 2>&1; then
    report OK homebrew "$BREW_BIN"
  else
    report WARN homebrew "found at $BREW_BIN but not on this shell PATH" "eval \"\$($BREW_BIN shellenv)\""
  fi
fi

# ── Source-build tools: node, npm, git ──────────────────────

NODE_BIN="$(command -v node 2>/dev/null)"
if [ -n "$NODE_BIN" ]; then
  NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null)"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
  if [ "$NODE_MAJOR" -ge 18 ]; then
    report OK node "$NODE_VERSION at $NODE_BIN (need 18+)"
  else
    report_source_tool node "${NODE_VERSION:-unknown version} at $NODE_BIN is too old (need 18+)" "$(fix_cmd node)"
  fi
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  report_source_tool node "not on PATH, but nvm is installed" '. "$HOME/.nvm/nvm.sh" && nvm install --lts'
else
  report_source_tool node "not found (need 18+)" "$(fix_cmd node)"
fi

NPM_BIN="$(command -v npm 2>/dev/null)"
if [ -n "$NPM_BIN" ]; then
  report OK npm "$NPM_BIN"
else
  report_source_tool npm "not found (it ships with Node.js)" "$(fix_cmd node)"
fi

GIT_BIN="$(command -v git 2>/dev/null)"
if [ -z "$GIT_BIN" ]; then
  report_source_tool git "not found" "$(fix_cmd git)"
elif [ "$PLATFORM" = "macos" ] && [ "$GIT_BIN" = "/usr/bin/git" ] && ! xcode-select -p >/dev/null 2>&1; then
  # /usr/bin/git is only a stub until the Command Line Tools are installed.
  # Running it would open an install dialog, so it is not run here.
  report_source_tool git "/usr/bin/git is a stub; the Xcode Command Line Tools are not installed" "$(fix_cmd git)"
else
  report OK git "$("$GIT_BIN" --version 2>/dev/null | sed 's/^git version //') at $GIT_BIN"
fi

# ── Audio tools: ffmpeg, sox, play ──────────────────────────

FFMPEG_BIN="$(find_tool ffmpeg)"
if [ -n "$FFMPEG_BIN" ]; then
  FFMPEG_VERSION="$("$FFMPEG_BIN" -version 2>/dev/null | sed -n '1s/^ffmpeg version \([^ ]*\).*/\1/p')"
  report OK ffmpeg "${FFMPEG_VERSION:-found} at $FFMPEG_BIN$(path_note ffmpeg)"
else
  report MISSING ffmpeg "not found; VoiceBridge uses it to capture the mic and handle audio" "$(fix_cmd ffmpeg)"
fi

# VoiceBridge streams translated speech through sox's play, or ffplay when play is
# missing, so one of the two is required.
FFPLAY_BIN="$(find_tool ffplay)"
SOX_BIN="$(find_tool sox)"
if [ -n "$SOX_BIN" ]; then
  SOX_VERSION="$("$SOX_BIN" --version 2>/dev/null | sed -n 's/.*SoX v\([0-9][0-9.]*\).*/\1/p' | head -n 1)"
  report OK sox "${SOX_VERSION:+v$SOX_VERSION }at $SOX_BIN$(path_note sox)"
elif [ -n "$FFPLAY_BIN" ]; then
  report WARN sox "not found; VoiceBridge will stream through ffplay instead (sox is still recommended)" "$(fix_cmd sox)"
else
  report MISSING sox "not found" "$(fix_cmd sox)"
fi

PLAY_BIN="$(find_tool play)"
if [ -n "$PLAY_BIN" ]; then
  report OK play "$PLAY_BIN$(path_note play)"
elif [ -n "$FFPLAY_BIN" ]; then
  report OK ffplay "$FFPLAY_BIN$(path_note ffplay); streams the translated audio (play from sox is not installed)"
else
  report MISSING play "not found; the play binary comes with sox and streams the translated audio (ffplay also works)" "$(fix_cmd sox)"
fi

# ── Virtual microphone ──────────────────────────────────────

if [ "$PLATFORM" = "macos" ]; then
  AUDIO_DEVICES="$(system_profiler SPAudioDataType 2>/dev/null)"
  if printf '%s\n' "$AUDIO_DEVICES" | grep -qi 'blackhole'; then
    BH_NAME="$(printf '%s\n' "$AUDIO_DEVICES" | grep -o 'BlackHole [0-9]*ch' | head -n 1)"
    report OK virtual-mic "${BH_NAME:-BlackHole} is listed by system_profiler SPAudioDataType"
  elif ls /Library/Audio/Plug-Ins/HAL 2>/dev/null | grep -qi 'blackhole'; then
    report MISSING virtual-mic "BlackHole is in /Library/Audio/Plug-Ins/HAL but macOS has not loaded it yet" "restart the Mac"
  else
    report MISSING virtual-mic "BlackHole not found in system_profiler SPAudioDataType" "$(fix_cmd vmic)"
  fi
fi

if [ "$PLATFORM" = "linux" ]; then
  if ! command -v pactl >/dev/null 2>&1; then
    report MISSING pactl "not found; VoiceBridge uses it to create and find the virtual mic on PulseAudio and PipeWire" "$(fix_cmd pactl)"
    report MISSING virtual-mic "cannot be checked without pactl"
  elif ! SERVER_INFO="$(LC_ALL=C pactl info 2>/dev/null)"; then
    report MISSING audio-server "pactl cannot reach PulseAudio or PipeWire from this shell" "run this from a terminal in the desktop session (not over SSH or with sudo); on PipeWire check: systemctl --user status pipewire-pulse"
    report MISSING virtual-mic "cannot be checked without an audio server"
  else
    SERVER_NAME="$(printf '%s\n' "$SERVER_INFO" | sed -n 's/^Server Name: //p')"
    report OK audio-server "${SERVER_NAME:-reachable}"

    SHORT_SINKS="$(pactl list short sinks 2>/dev/null)"
    SHORT_SOURCES="$(pactl list short sources 2>/dev/null)"
    # Null sinks show "module-null-sink" on PulseAudio and
    # "support.null-audio-sink" on PipeWire. auto_null is PipeWire's dummy
    # output when no sound card exists, not a virtual mic.
    NULL_SINKS="$(LC_ALL=C pactl list sinks 2>/dev/null | awk '
      /^Sink #/ { if (name != "" && isnull) print name; name = ""; isnull = 0; next }
      /^[ \t]*Name: / { name = $2; next }
      /module-null-sink|null-audio-sink/ { isnull = 1 }
      END { if (name != "" && isnull) print name }' | grep -v '^auto_null$' | tr '\n' ' ' | sed 's/ *$//')"

    if printf '%s\n' "$SHORT_SINKS" | awk -F'\t' '$2 == "voicebridge" { found = 1 } END { exit !found }'; then
      if printf '%s\n' "$SHORT_SOURCES" | awk -F'\t' '$2 == "voicebridge.monitor" { found = 1 } END { exit !found }'; then
        report OK virtual-mic "null sink voicebridge is loaded; meeting apps use its monitor source voicebridge.monitor (shown as Monitor of VoiceBridge Mic)"
      else
        report OK virtual-mic "null sink voicebridge is loaded (no voicebridge.monitor source listed)"
      fi
    elif [ -n "$NULL_SINKS" ]; then
      report WARN virtual-mic "null sink(s) found: $NULL_SINKS; VoiceBridge looks for one named voicebridge" "$(fix_cmd vmic)"
    else
      report MISSING virtual-mic "no null sink found in pactl list sinks" "$(fix_cmd vmic)"
    fi
  fi
fi

# ── VoiceBridge checkout (optional) ─────────────────────────

if [ -n "$CHECKOUT" ]; then
  PKG="$CHECKOUT/desktop/package.json"
  if [ -f "$PKG" ]; then
    if grep -q '"name"[[:space:]]*:[[:space:]]*"voicebridge-desktop"' "$PKG"; then
      report OK checkout "$PKG is voicebridge-desktop"
    else
      report MISSING checkout "$PKG is not the VoiceBridge desktop app"
    fi
    if [ -d "$CHECKOUT/desktop/node_modules" ]; then
      report OK dependencies "$CHECKOUT/desktop/node_modules exists"
    else
      report MISSING dependencies "$CHECKOUT/desktop/node_modules not found" "cd \"$CHECKOUT/desktop\" && npm install"
    fi
  elif [ -e "$CHECKOUT" ]; then
    report MISSING checkout "$CHECKOUT has no desktop/package.json, so it is not a VoiceBridge checkout"
  else
    report MISSING checkout "$CHECKOUT does not exist" "git clone https://github.com/AlleyBo55/VoiceBridge.git \"$CHECKOUT\""
  fi
fi

# ── Result ──────────────────────────────────────────────────

echo
if [ "$MISSING_COUNT" -eq 0 ]; then
  echo "Result: all required checks passed ($WARN_COUNT warning(s))."
  exit 0
fi
echo "Result: $MISSING_COUNT required check(s) missing, $WARN_COUNT warning(s). Ask the user before running any fix command."
exit 1
