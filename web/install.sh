#!/bin/sh
# FOAR installer for macOS and Linux.
#
#   curl -fsSL https://josmanvis.github.io/FOAR/install.sh | sh
#
# Options (after `| sh -s --`):
#   --version <v>        install a given release (default: the latest)
#   --dir <path>         install into <path>/bin (default: ~/.foar)
#   --no-modify-path     don't touch shell profiles
#   --uninstall          remove foar
# Environment: FOAR_VERSION, FOAR_INSTALL, FOAR_BIN_DIR, FOAR_DOWNLOAD_URL, NO_COLOR.
#
# What it does: downloads the release archive for this platform from GitHub,
# checks its SHA-256, puts `foar` in ~/.foar/bin and makes it reachable on
# your PATH (a link from a directory already on it, or your shell profile).
#
# Everything is inside main(), which runs on the last line: a download cut
# short never runs half a script.

set -u

REPO_URL="https://github.com/josmanvis/FOAR"
DOCS_URL="https://josmanvis.github.io/FOAR/docs/guide.html"
DEFAULT_TAG="v0.4.0"

# ---- output ------------------------------------------------------------------------

setup_colors() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    case "${COLORTERM:-}" in
      truecolor | 24bit) LAMP='\033[38;2;242;179;61m'; RAIL='\033[38;2;132;156;143m' ;;
      *) LAMP='\033[38;5;214m'; RAIL='\033[38;5;108m' ;;
    esac
    OK='\033[32m'; ERR='\033[31m'; DIM='\033[2m'; BOLD='\033[1m'; CYAN='\033[36m'; RESET='\033[0m'
    TTY=1
  else
    LAMP=''; RAIL=''; OK=''; ERR=''; DIM=''; BOLD=''; CYAN=''; RESET=''; TTY=0
  fi
}

say() { printf '%b\n' "$*"; }

header() {
  say ""
  say "  ${LAMP}●${RESET}${RAIL}━━━${RESET}  ${BOLD}FOAR${RESET} ${DIM}installer${RESET}"
  say ""
}

# row <label> <value> [mark]
row() {
  if [ $TTY = 1 ]; then printf '\r\033[K'; fi
  printf "  ${DIM}%-11s${RESET}%b" "$1" "$2"
  if [ -n "${3:-}" ]; then printf '  %b' "$3"; fi
  printf '\n'
}

done_mark() { printf '%b' "${OK}✓${RESET}"; }

fail() {
  if [ "${TTY:-0}" = 1 ]; then printf '\r\033[K'; fi
  say "  ${ERR}✗${RESET} $1"
  shift
  for line in "$@"; do say "    ${DIM}$line${RESET}"; done
  say ""
  exit 1
}

# spin <label> <value> <pid>: a spinner until <pid> exits; returns its status
spin() {
  if [ $TTY = 1 ]; then
    i=0
    while kill -0 "$3" 2>/dev/null; do
      i=$(( (i + 1) % 10 ))
      case $i in
        0) f='⠋' ;; 1) f='⠙' ;; 2) f='⠹' ;; 3) f='⠸' ;; 4) f='⠼' ;;
        5) f='⠴' ;; 6) f='⠦' ;; 7) f='⠧' ;; 8) f='⠇' ;; *) f='⠏' ;;
      esac
      printf "\r  ${DIM}%-11s${RESET}%b  ${LAMP}%s${RESET}" "$1" "$2" "$f"
      sleep 0.08 2>/dev/null || sleep 1
    done
  fi
  wait "$3"
}

tilde() { case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }

human_size() {
  awk -v b="$1" 'BEGIN { if (b >= 1048576) printf "%.1f MB", b / 1048576; else printf "%d KB", (b + 1023) / 1024 }'
}

# ---- platform -----------------------------------------------------------------------

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      # an Intel shell on Apple silicon (Rosetta) still gets the native build
      if [ "$arch" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then arch=arm64; fi
      os_name="macOS"; os_triple="apple-darwin" ;;
    Linux)
      os_name="Linux"; os_triple="unknown-linux-musl" ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "This is Windows. Install from PowerShell instead:" "irm https://josmanvis.github.io/FOAR/install.ps1 | iex" ;;
    *)
      fail "There's no prebuilt foar for $os." "Build it from source: $REPO_URL#build-from-source" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch_triple="x86_64"; arch_name="x64" ;;
    arm64 | aarch64) arch_triple="aarch64"; arch_name="arm64" ;;
    *) fail "There's no prebuilt foar for $os on $arch." "Build it from source: $REPO_URL#build-from-source" ;;
  esac
  TARGET="$arch_triple-$os_triple"
  PLATFORM="$os_name $arch_name"
}

# ---- downloads -----------------------------------------------------------------------

need_downloader() {
  if command -v curl >/dev/null 2>&1; then DL=curl
  elif command -v wget >/dev/null 2>&1; then DL=wget
  else fail "Neither curl nor wget is installed." "Install one of them and run this again."
  fi
}

# fetch <url> <file>
fetch() {
  if [ "$DL" = curl ]; then curl -fsSL --retry 2 -o "$2" "$1"
  else wget -q -O "$2" "$1"
  fi
}

# the newest release tag (v1.2.3), with 3 fallback tiers:
# 1. HTTP redirect from /releases/latest -> /releases/tag/vX.Y.Z
# 2. GitHub Releases API (/repos/josmanvis/FOAR/releases/latest)
# 3. Embedded DEFAULT_TAG when proxied/rate-limited
latest_tag() {
  url=""
  if [ "$DL" = curl ]; then
    url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$BASE/latest" 2>/dev/null) || url=""
  else
    url=$(wget -q -S --spider "$BASE/latest" 2>&1 | awk '/^  Location: /{ l = $2 } END { print l }')
  fi
  case "$url" in
    */tag/*)
      printf '%s' "${url##*/tag/}" | tr -d '\r\n '
      return 0
      ;;
  esac
  api_url="https://api.github.com/repos/josmanvis/FOAR/releases/latest"
  if [ "$DL" = curl ]; then
    tag=$(curl -fsSL "$api_url" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  else
    tag=$(wget -q -O - "$api_url" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  fi
  if [ -n "$tag" ]; then
    printf '%s' "$tag" | tr -d '\r\n '
    return 0
  fi
  printf '%s' "$DEFAULT_TAG"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else printf ''
  fi
}

# ---- PATH -----------------------------------------------------------------------------

on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }

# a directory on PATH that we can write to, for a link to foar
link_dir() {
  for d in "$HOME/.local/bin" "$HOME/bin" /opt/homebrew/bin /usr/local/bin; do
    if on_path "$d" && [ -d "$d" ] && [ -w "$d" ]; then printf '%s' "$d"; return 0; fi
  done
  return 1
}

profile_file() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = Darwin ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi ;;
    fish) printf '%s' "$HOME/.config/fish/conf.d/foar.fish" ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

MARK_BEGIN="# >>> foar >>>"
MARK_END="# <<< foar <<<"

# a path for shell profiles: $HOME/… when it's under the home directory
home_rel() { case "$1" in "$HOME"/*) printf '$HOME/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }

add_to_profile() {
  file=$(profile_file)
  if [ -f "$file" ] && grep -q "$MARK_BEGIN" "$file" 2>/dev/null; then return 0; fi
  mkdir -p "$(dirname "$file")"
  case "$file" in
    *.fish) line="fish_add_path \"$(home_rel "$1")\"" ;;
    *) line="export PATH=\"$(home_rel "$1"):\$PATH\"" ;;
  esac
  printf '\n%s\n%s\n%s\n' "$MARK_BEGIN" "$line" "$MARK_END" >> "$file"
}

remove_from_profiles() {
  for file in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.config/fish/conf.d/foar.fish"; do
    [ -f "$file" ] && grep -q "$MARK_BEGIN" "$file" 2>/dev/null || continue
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0 == b { skip = 1; next } $0 == e { skip = 0; next } !skip' "$file" > "$file.foar-tmp" && mv "$file.foar-tmp" "$file"
    row "Profile" "$(tilde "$file")" "${DIM}cleaned${RESET}"
  done
}

# ---- commands --------------------------------------------------------------------------

uninstall() {
  header
  removed=0
  for d in "$HOME/.local/bin" "$HOME/bin" /opt/homebrew/bin /usr/local/bin; do
    if [ -L "$d/foar" ] && readlink "$d/foar" | grep -q "$BIN_DIR"; then
      rm -f "$d/foar" && row "Link" "$(tilde "$d/foar")" "${DIM}removed${RESET}"
    fi
  done
  if [ -f "$BIN_DIR/foar" ]; then
    rm -f "$BIN_DIR/foar" && removed=1
    rmdir "$BIN_DIR" 2>/dev/null
    rmdir "$INSTALL_ROOT" 2>/dev/null
    row "Binary" "$(tilde "$BIN_DIR/foar")" "${DIM}removed${RESET}"
  fi
  remove_from_profiles
  say ""
  if [ $removed = 1 ]; then say "  foar is uninstalled."; else say "  foar wasn't installed in $(tilde "$BIN_DIR")."; fi
  say ""
}

install() {
  header
  detect_target
  need_downloader
  row "Platform" "$PLATFORM"

  case "$VERSION" in
    latest | "")
      TAG=$(latest_tag)
      if [ -z "$TAG" ]; then
        fail "Couldn't find the latest release." "Check your connection, or see $REPO_URL/releases"
      fi ;;
    v*) TAG="$VERSION" ;;
    *) TAG="v$VERSION" ;;
  esac
  row "Version" "${TAG#v}"

  ASSET="foar-$TARGET.tar.gz"
  URL="$BASE/download/$TAG/$ASSET"
  TMP=$(mktemp -d 2>/dev/null || mktemp -d -t foar)
  trap 'rm -rf "$TMP"' EXIT INT TERM

  fetch "$URL" "$TMP/$ASSET" 2>"$TMP/err" &
  if ! spin "Download" "$ASSET" $!; then
    fail "Download failed: $URL" "$(head -c 300 "$TMP/err" 2>/dev/null)" "Releases: $REPO_URL/releases"
  fi
  row "Download" "$ASSET ${DIM}$(human_size "$(wc -c < "$TMP/$ASSET" | tr -d ' ')")${RESET}" "$(done_mark)"

  if fetch "$URL.sha256" "$TMP/sum" 2>/dev/null; then
    want=$(cut -d' ' -f1 < "$TMP/sum")
    got=$(sha256_of "$TMP/$ASSET")
    if [ -z "$got" ]; then
      row "Checksum" "${DIM}skipped (no sha256sum or shasum)${RESET}"
    elif [ "$want" != "$got" ]; then
      fail "The download doesn't match its checksum, so it wasn't installed." "expected $want" "got      $got"
    else
      row "Checksum" "sha256 $(printf '%s' "$got" | cut -c1-12)…" "$(done_mark)"
    fi
  else
    fail "Couldn't download the checksum for $ASSET." "$URL.sha256"
  fi

  tar -xzf "$TMP/$ASSET" -C "$TMP" || fail "Couldn't unpack $ASSET."
  mkdir -p "$BIN_DIR" || fail "Couldn't create $BIN_DIR."
  # copy then rename: replacing a running foar (foar upgrade) is safe
  cp "$TMP/foar-$TARGET/foar" "$BIN_DIR/.foar-new" && chmod 755 "$BIN_DIR/.foar-new" && mv -f "$BIN_DIR/.foar-new" "$BIN_DIR/foar" \
    || fail "Couldn't write $BIN_DIR/foar."
  if [ "$(uname -s)" = Darwin ]; then
    xattr -d com.apple.quarantine "$BIN_DIR/foar" 2>/dev/null || true
    codesign --force --sign - "$BIN_DIR/foar" 2>/dev/null || true
  fi
  INSTALLED=$("$BIN_DIR/foar" --version 2>/dev/null) || fail "The installed foar doesn't run on this machine." "$BIN_DIR/foar"
  row "Installed" "$(tilde "$BIN_DIR/foar")" "$(done_mark)"

  # make `foar` work right away
  READY=1
  RESTART=""
  if on_path "$BIN_DIR"; then
    row "On PATH" "$(tilde "$BIN_DIR")" "$(done_mark)"
  elif dir=$(link_dir); then
    ln -sf "$BIN_DIR/foar" "$dir/foar" && row "On PATH" "linked from $(tilde "$dir")" "$(done_mark)"
  elif [ "$MODIFY_PATH" = 1 ]; then
    add_to_profile "$BIN_DIR"
    row "On PATH" "added to $(tilde "$(profile_file)")" "$(done_mark)"
    READY=0
    case "$(profile_file)" in
      *.fish) RESTART="fish_add_path \"$(home_rel "$BIN_DIR")\"" ;;
      *) RESTART="export PATH=\"$(home_rel "$BIN_DIR"):\$PATH\"" ;;
    esac
  else
    row "On PATH" "${DIM}not changed (--no-modify-path)${RESET}"
    READY=0
    RESTART="export PATH=\"$(home_rel "$BIN_DIR"):\$PATH\""
  fi

  say ""
  say "  ${OK}${INSTALLED}${RESET} is ready."
  if [ $READY = 0 ]; then
    say ""
    say "  New terminals will find it. For this one, run:"
    say ""
    say "    ${CYAN}${RESTART}${RESET}"
  fi
  say ""
  say "  Start a project:"
  say ""
  say "    ${CYAN}foar init my-app${RESET}"
  say "    ${CYAN}cd my-app${RESET}"
  say "    ${CYAN}foar dev${RESET}"
  say ""
  say "  ${DIM}Guide${RESET}    $DOCS_URL"
  say "  ${DIM}Update${RESET}   foar upgrade"
  say ""
}

usage() {
  cat <<EOF
FOAR installer

  curl -fsSL https://josmanvis.github.io/FOAR/install.sh | sh
  curl -fsSL https://josmanvis.github.io/FOAR/install.sh | sh -s -- [options]

Options:
  --version <v>      install a given release, e.g. 0.3.0 (default: latest)
  --dir <path>       install into <path>/bin (default: ~/.foar)
  --no-modify-path   don't edit shell profiles
  --uninstall        remove foar
  -h, --help         this help
EOF
}

main() {
  setup_colors
  VERSION="${FOAR_VERSION:-latest}"
  INSTALL_ROOT="${FOAR_INSTALL:-$HOME/.foar}"
  BIN_DIR="${FOAR_BIN_DIR:-}"
  BASE="${FOAR_DOWNLOAD_URL:-$REPO_URL/releases}"
  MODIFY_PATH=1
  ACTION=install
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) VERSION="${2:?--version needs a value}"; shift ;;
      --version=*) VERSION="${1#*=}" ;;
      --dir) INSTALL_ROOT="${2:?--dir needs a value}"; BIN_DIR=""; shift ;;
      --dir=*) INSTALL_ROOT="${1#*=}"; BIN_DIR="" ;;
      --no-modify-path) MODIFY_PATH=0 ;;
      --uninstall) ACTION=uninstall ;;
      -h | --help) usage; exit 0 ;;
      *) usage; exit 2 ;;
    esac
    shift
  done
  [ -n "$BIN_DIR" ] || BIN_DIR="$INSTALL_ROOT/bin"
  if [ "$ACTION" = uninstall ]; then uninstall; else install; fi
}

main "$@"
