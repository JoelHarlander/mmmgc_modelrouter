#!/usr/bin/env bash
# Install router-endpoint (and optionally a local Laya classifier) as a service.
#
#   deploy/install.sh [command] [options]
#
# Commands
#   install     copy the app, write config and service files, start the service   (default)
#   uninstall   stop and remove the service files; state and config stay unless --purge
#   status      what is installed, whether it answers, and where the token is
#   token       print the API token the clients need
#   doctor      what this machine looks like to the installer, and what is missing
#
# Options
#   --user              per-user service (default). Needs no root; survives logout via linger.
#   --system            system-wide service that starts at boot. Needs root; runs as --run-as.
#   --run-as NAME       the account the service runs as (default: you, or $SUDO_USER with --system)
#   --port N            router port (default 8788)
#   --no-laya           do not install Laya; classify with TypeSafe Jev, then a heuristic
#   --laya-venv DIR     use (or create) the Laya virtualenv here
#   --laya-cpu          install the CPU-only torch wheel (smaller; the default wheel is CUDA)
#   --force-env         rewrite the env file even though one exists
#   --purge             with uninstall: also remove config, the app copy and the Laya venv
#   --dry-run           print everything that would be written, change nothing
#   --stage DIR         write files under DIR and touch no service manager (for packaging, tests)
#   -h, --help
#
# What it adapts to: Linux or macOS; the distro (from /etc/os-release) for prerequisite hints and
# for immutable systems (Fedora Atomic/Silverblue/Bazzite, MicroOS, NixOS) where /usr is read-only;
# the init system (systemd, OpenRC, runit, launchd); SELinux; and the GPU generation for Laya.
#
# Test hooks: ROUTER_DEPLOY_OS_RELEASE, ROUTER_DEPLOY_UNAME, ROUTER_DEPLOY_INIT, ROUTER_DEPLOY_NODE.

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENDPOINT_DIR="$(cd "$SELF_DIR/.." && pwd)"

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---- arguments ---------------------------------------------------------------------------------

CMD=install
MODE=user
RUN_AS=
PORT=8788
LAYA=1
LAYA_VENV=
LAYA_CPU=0
FORCE_ENV=0
PURGE=0
DRY_RUN=0
STAGE=

if [ $# -gt 0 ]; then
  case "$1" in
    install | uninstall | status | token | doctor | print-os) CMD="$1"; shift ;;
  esac
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --user) MODE=user ;;
    --system) MODE=system ;;
    --run-as) RUN_AS="${2:?--run-as needs a name}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --no-laya) LAYA=0 ;;
    --laya-venv) LAYA_VENV="${2:?--laya-venv needs a directory}"; shift ;;
    --laya-cpu) LAYA_CPU=1 ;;
    --force-env) FORCE_ENV=1 ;;
    --purge) PURGE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --stage) STAGE="${2:?--stage needs a directory}"; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

case "$PORT" in '' | *[!0-9]*) die "--port must be a number" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be 1-65535"

# ---- detection ---------------------------------------------------------------------------------

OS_KIND=other     # linux | macos | other
DISTRO_ID=unknown
DISTRO_LIKE=
DISTRO_NAME=unknown
IMMUTABLE=0
PKG=none          # dnf | apt | pacman | zypper | apk | xbps | nix | brew | none
INIT=none         # systemd | openrc | runit | launchd | none

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# An unrecognised distro: use whatever package manager is installed. A test fixture never consults the host.
fallback_pkg_manager() {
  local cmd
  [ -z "${ROUTER_DEPLOY_OS_RELEASE:-}" ] || return 0
  for cmd in dnf apt-get pacman zypper apk xbps-install nix-env; do
    if command -v "$cmd" >/dev/null 2>&1; then
      case "$cmd" in apt-get) PKG=apt ;; xbps-install) PKG=xbps ;; nix-env) PKG=nix ;; *) PKG="$cmd" ;; esac
      return 0
    fi
  done
}

detect_platform() {
  local uname_s osr key val
  uname_s="${ROUTER_DEPLOY_UNAME:-$(uname -s)}"
  case "$uname_s" in
    Linux) OS_KIND=linux ;;
    Darwin) OS_KIND=macos ;;
    *) OS_KIND=other ;;
  esac

  if [ "$OS_KIND" = macos ]; then
    DISTRO_ID=macos
    DISTRO_NAME="macOS"
    PKG=none
    command -v brew >/dev/null 2>&1 && PKG=brew
    INIT=launchd
    return 0
  fi

  osr="${ROUTER_DEPLOY_OS_RELEASE:-/etc/os-release}"
  local variant=
  if [ -r "$osr" ]; then
    # Read key=value lines without sourcing the file: it is data, not code.
    while IFS='=' read -r key val; do
      val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
      case "$key" in
        ID) DISTRO_ID="$(lower "$val")" ;;
        ID_LIKE) DISTRO_LIKE="$(lower "$val")" ;;
        PRETTY_NAME) DISTRO_NAME="$val" ;;
        VARIANT_ID) variant="$(lower "$val")" ;;
      esac
    done < "$osr"
  fi

  # Package manager, by the distro's family and then by what is actually installed.
  local family=" $DISTRO_ID $DISTRO_LIKE "
  case "$family" in
    *" fedora "* | *" rhel "* | *" centos "*) PKG=dnf ;;
    *" debian "* | *" ubuntu "*) PKG=apt ;;
    *" arch "*) PKG=pacman ;;
    *" suse "* | *" opensuse "*) PKG=zypper ;;
    *" alpine "*) PKG=apk ;;
    *" void "*) PKG=xbps ;;
    *" nixos "*) PKG=nix ;;
    *) fallback_pkg_manager ;;
  esac

  is_immutable "$variant" && IMMUTABLE=1

  if [ -n "${ROUTER_DEPLOY_INIT:-}" ]; then
    INIT="$ROUTER_DEPLOY_INIT"
  elif [ -n "${ROUTER_DEPLOY_OS_RELEASE:-}" ]; then
    # A fixture describes its own distro; the machine running the test does not get a vote.
    case "$DISTRO_ID" in alpine) INIT=openrc ;; void) INIT=runit ;; *) INIT=systemd ;; esac
  elif [ -d /run/systemd/system ]; then
    INIT=systemd
  elif [ -d /run/openrc ] || { command -v rc-service >/dev/null 2>&1 && command -v openrc-run >/dev/null 2>&1; }; then
    INIT=openrc
  elif [ -d /etc/runit ] || command -v sv >/dev/null 2>&1; then
    INIT=runit
  fi
}

# Immutable roots: /usr is read-only and packages are layered or live in a toolbox.
is_immutable() {
  case "$1:$DISTRO_ID" in
    silverblue:* | kinoite:* | coreos:* | atomic:* | *:nixos | *:opensuse-microos | *:sle-micro) return 0 ;;
  esac
  [ -z "${ROUTER_DEPLOY_OS_RELEASE:-}" ] || return 1
  [ -e /run/ostree-booted ] || [ -e /etc/NIXOS ] || [ -x /usr/sbin/transactional-update ]
}

selinux_enforcing() {
  [ -n "${ROUTER_DEPLOY_OS_RELEASE:-}" ] && return 1
  command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = Enforcing ]
}

print_os() {
  log "os:        $OS_KIND"
  log "distro:    $DISTRO_NAME ($DISTRO_ID${DISTRO_LIKE:+, like $DISTRO_LIKE})"
  log "immutable: $([ "$IMMUTABLE" = 1 ] && echo yes || echo no)"
  log "packages:  $PKG"
  log "init:      $INIT"
}

# ---- prerequisites -----------------------------------------------------------------------------

node_hint() {
  case "$PKG" in
    dnf)
      if [ "$IMMUTABLE" = 1 ]; then
        log "  This is an immutable system. Prefer a user-level Node (https://nodejs.org, or 'brew install node', or a toolbox):"
        log "    brew install node          # Homebrew on Linux, if you use it"
        log "    rpm-ostree install nodejs  # layers it and needs a reboot"
      else
        log "  sudo dnf install nodejs"
      fi ;;
    apt) log "  sudo apt install nodejs   # Debian/Ubuntu releases may ship Node < 20; if so use https://deb.nodesource.com or nvm" ;;
    pacman) log "  sudo pacman -S nodejs npm" ;;
    zypper) log "  sudo zypper install nodejs20" ;;
    apk) log "  sudo apk add nodejs" ;;
    xbps) log "  sudo xbps-install nodejs" ;;
    nix) log "  nix-env -iA nixpkgs.nodejs_22   # or add pkgs.nodejs_22 to your configuration" ;;
    brew) log "  brew install node" ;;
    *) log "  Install Node.js 20 or newer from https://nodejs.org" ;;
  esac
}

NODE_BIN=
find_node() {
  NODE_BIN="${ROUTER_DEPLOY_NODE:-$(command -v node || true)}"
  if [ -z "$NODE_BIN" ]; then
    warn "node not found. router-endpoint needs Node.js 20 or newer:"
    node_hint >&2
    return 1
  fi
  local major
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -lt 20 ]; then
    warn "node at $NODE_BIN is version $("$NODE_BIN" --version 2>/dev/null || echo '?'); router-endpoint needs 20 or newer:"
    node_hint >&2
    return 1
  fi
  case "$NODE_BIN" in
    */.nvm/* | */.asdf/* | */.volta/* | */.fnm/* | */.local/share/mise/*)
      warn "node at $NODE_BIN comes from a version manager; the service pins that exact binary, so re-run this installer after upgrading Node." ;;
  esac
}

CLAUDE_BIN=
find_claude() {
  CLAUDE_BIN="$(command -v claude || true)"
  [ -n "$CLAUDE_BIN" ] || warn "the claude CLI is not on PATH. Claude subscription accounts need it (https://claude.com/claude-code); other account kinds work without."
}

# ---- paths -------------------------------------------------------------------------------------

SERVICE_USER=
SERVICE_HOME=
APP_DIR=
ENV_FILE=
RUN_WRAPPER=
LAYA_DIR=
UNIT_DIR=
LOG_DIR=

home_of() {
  local user="$1" home=
  if [ "$OS_KIND" = macos ]; then
    home="$(dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  else
    home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6)"
  fi
  [ -n "$home" ] || home="$(eval "printf '%s' ~$user")"
  printf '%s' "$home"
}

resolve_paths() {
  if [ "$MODE" = system ]; then
    SERVICE_USER="${RUN_AS:-${SUDO_USER:-}}"
    [ -n "$SERVICE_USER" ] || die "--system needs --run-as NAME (the account whose pi and Claude logins the service uses)"
    SERVICE_HOME="$(home_of "$SERVICE_USER")"
    APP_DIR=/var/lib/router-endpoint/app
    LAYA_DIR="${LAYA_VENV:-/var/lib/router-endpoint/laya-venv}"
    ENV_FILE=/etc/router-endpoint/env
    RUN_WRAPPER=/var/lib/router-endpoint/run
    LOG_DIR=/var/log
    case "$INIT" in systemd) UNIT_DIR=/etc/systemd/system ;; esac
  else
    SERVICE_USER="${RUN_AS:-$(id -un)}"
    [ "$SERVICE_USER" = "$(id -un)" ] || die "--run-as with --user must be yourself; use --system to run as another account"
    SERVICE_HOME="${HOME:?HOME is not set}"
    local data="${XDG_DATA_HOME:-$SERVICE_HOME/.local/share}" conf="${XDG_CONFIG_HOME:-$SERVICE_HOME/.config}"
    APP_DIR="$data/router-endpoint/app"
    LAYA_DIR="${LAYA_VENV:-$data/router-endpoint/laya-venv}"
    ENV_FILE="$conf/router-endpoint/env"
    RUN_WRAPPER="$data/router-endpoint/run"
    case "$INIT" in
      systemd) UNIT_DIR="$conf/systemd/user" ;;
      launchd) UNIT_DIR="$SERVICE_HOME/Library/LaunchAgents"; LOG_DIR="$SERVICE_HOME/Library/Logs" ;;
    esac
  fi
  # Everything below is written into files that a shell or systemd reads back: no spaces or quotes.
  local p
  for p in "$APP_DIR" "$LAYA_DIR" "$ENV_FILE" "$RUN_WRAPPER" "$SERVICE_HOME" "$NODE_BIN" "$CLAUDE_BIN"; do
    case "$p" in *[[:space:]\"\'\\\$\`]*) die "path contains a space or shell character, which the service files cannot carry safely: $p" ;; esac
  done
}

# Where a path really lands: under --stage when staging.
at() { if [ -n "$STAGE" ]; then printf '%s%s' "$STAGE" "$1"; else printf '%s' "$1"; fi; }

sudo_if_needed() {
  if [ "$MODE" = system ] && [ "$(id -u)" != 0 ] && [ -z "$STAGE" ] && [ "$DRY_RUN" = 0 ]; then
    die "--system writes under /etc and /var/lib: re-run with sudo (and --run-as $SERVICE_USER)"
  fi
}

# ---- writing files -----------------------------------------------------------------------------

# write_file PATH MODE < content
write_file() {
  local path="$1" mode="$2" target tmp
  target="$(at "$path")"
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "--- $path (mode $mode)"
    cat
    printf '\n'
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  tmp="$(mktemp "${target}.XXXXXX")"
  cat > "$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$target"
}

# ---- service definitions -----------------------------------------------------------------------

render_env() {
  local path_dirs
  path_dirs="$(dirname "$NODE_BIN")"
  if [ -n "$CLAUDE_BIN" ] && [ "$(dirname "$CLAUDE_BIN")" != "$path_dirs" ]; then path_dirs="$path_dirs:$(dirname "$CLAUDE_BIN")"; fi
  cat <<EOF
# router-endpoint environment. Plain KEY=value lines, read by systemd and by sh alike: no quotes, no spaces.
# Edit, then restart the service. Re-running the installer keeps this file unless --force-env is given.
ROUTER_HOST=127.0.0.1
ROUTER_PORT=$PORT
ROUTER_STATE=$SERVICE_HOME/.pi/agent/router-endpoint.json
ROUTER_AUTH=$SERVICE_HOME/.pi/agent/auth.json
LAYA_URL=$([ "$LAYA" = 1 ] && echo "http://127.0.0.1:8787" || echo "")
PATH=$path_dirs:/usr/local/bin:/usr/bin:/bin
$(emit_if "${CLAUDE_BIN:+CLAUDE_BIN=$CLAUDE_BIN}")
# Fallback classifier when Laya is down. Leave unset to use the typesafe key in pi's auth.json.
#TYPESAFE_API_KEY=
EOF
}

render_wrapper() {
  cat <<EOF
#!/bin/sh
# Starts router-endpoint with its env file. Used by init systems that have no EnvironmentFile.
set -a
. "$ENV_FILE"
set +a
exec "$NODE_BIN" "$APP_DIR/src/main.mjs"
EOF
}

render_laya_wrapper() {
  cat <<EOF
#!/bin/sh
# Starts the local Laya classifier, bound to loopback only.
LAYA_HOST=127.0.0.1 LAYA_PORT=8787 LAYA_MODELS=english LAYA_JEV_STRICT=1 \\
  exec "$LAYA_DIR/bin/python" -m laya.serve
EOF
}

# Print $1 and a newline when it is not empty: keeps optional unit lines from leaving blank ones behind.
emit_if() {
  [ -z "$1" ] || printf '%s\n' "$1"
  return 0
}

# Modest sandboxing for system units. ProtectHome and ProtectSystem=strict are left off on purpose:
# the Claude CLI and pi write their logins and state under the account's home. User units get none:
# the sandbox directives need user namespaces, which several distros disable for unprivileged users.
system_hardening() {
  printf '%s\n' "NoNewPrivileges=yes" "PrivateTmp=yes" "ProtectSystem=full" "ProtectKernelModules=yes" \
    "ProtectControlGroups=yes" "RestrictSUIDSGID=yes" "LockPersonality=yes"
}

render_systemd_router() {
  local wanted=default.target after=laya.service
  if [ "$MODE" = system ]; then wanted=multi-user.target; after="network-online.target laya.service"; fi
  {
    printf '[Unit]\nDescription=router-endpoint: one OpenAI/Anthropic model (auto) for pi and OpenCode\n'
    printf 'After=%s\n' "$after"
    [ "$LAYA" = 1 ] && printf 'Wants=laya.service\n'
    printf '\n[Service]\nType=simple\n'
    [ "$MODE" = system ] && printf 'User=%s\n' "$SERVICE_USER"
    printf 'EnvironmentFile=%s\nExecStart=%s %s/src/main.mjs\nRestart=on-failure\nRestartSec=3\n' "$ENV_FILE" "$NODE_BIN" "$APP_DIR"
    [ "$MODE" = system ] && system_hardening
    printf '\n[Install]\nWantedBy=%s\n' "$wanted"
  }
  return 0
}

render_systemd_laya() {
  local wanted=default.target
  [ "$MODE" = system ] && wanted=multi-user.target
  {
    printf '[Unit]\nDescription=Laya classifier for router-endpoint (loopback only)\n'
    printf '\n[Service]\nType=simple\n'
    [ "$MODE" = system ] && printf 'User=%s\n' "$SERVICE_USER"
    printf 'Environment=LAYA_HOST=127.0.0.1\nEnvironment=LAYA_PORT=8787\nEnvironment=LAYA_MODELS=english\nEnvironment=LAYA_JEV_STRICT=1\n'
    printf 'ExecStart=%s/bin/python -m laya.serve\nRestart=on-failure\nRestartSec=5\n' "$LAYA_DIR"
    printf '# Loading the checkpoint takes a while on a cold cache.\nTimeoutStartSec=600\nNice=5\n'
    [ "$MODE" = system ] && system_hardening
    printf '\n[Install]\nWantedBy=%s\n' "$wanted"
  }
  return 0
}

render_launchd() { # render_launchd LABEL PROGRAM LOGNAME
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array><string>$2</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/$3.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$3.log</string>
</dict>
</plist>
EOF
}

render_openrc() { # render_openrc NAME WRAPPER DESCRIPTION [uses]
  cat <<EOF
#!/sbin/openrc-run
description="$3"
command="$2"
command_user="$SERVICE_USER"
supervisor="supervise-daemon"
output_log="/var/log/$1.log"
error_log="/var/log/$1.log"
respawn_delay=3

depend() {
	need net
	${4:+use $4}
}
EOF
}

render_runit() { # render_runit WRAPPER
  cat <<EOF
#!/bin/sh
exec 2>&1
exec chpst -u $SERVICE_USER $1
EOF
}

# ---- laya --------------------------------------------------------------------------------------

gpu_needs_cu126() {
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  local cc
  cc="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '[:space:]')"
  [ -n "$cc" ] || return 1
  # Below compute capability 7.5 (Pascal and older) the default CUDA 13 torch wheel has no kernels.
  awk -v cc="$cc" 'BEGIN { exit !(cc + 0 < 7.5) }'
}

install_laya() {
  [ "$LAYA" = 1 ] || return 0
  if [ -x "$(at "$LAYA_DIR")/bin/python" ] && "$(at "$LAYA_DIR")/bin/python" -c 'import laya' >/dev/null 2>&1; then
    log "laya: already installed in $LAYA_DIR"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ] || [ -n "$STAGE" ]; then
    log "laya: would create $LAYA_DIR and install laya[serve]$([ "$LAYA_CPU" = 1 ] && echo ' with the CPU torch wheel')"
    return 0
  fi
  local py index=
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$LAYA_DIR" >/dev/null
    py="$LAYA_DIR/bin/python"
    pipi() { uv pip install --python "$py" "$@"; }
  else
    command -v python3 >/dev/null 2>&1 || { warn "python3 not found: skipping Laya (re-run with Python 3.10+ or uv, or pass --no-laya)"; LAYA=0; return 0; }
    python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || { warn "Laya needs Python 3.10 or newer: skipping it"; LAYA=0; return 0; }
    python3 -m venv "$LAYA_DIR" || { warn "python3 -m venv failed (on Debian/Ubuntu: apt install python3-venv): skipping Laya"; LAYA=0; return 0; }
    py="$LAYA_DIR/bin/python"
    pipi() { "$py" -m pip install --quiet "$@"; }
  fi
  if [ "$LAYA_CPU" = 1 ]; then
    index=cpu
  elif gpu_needs_cu126; then
    index=cu126
    log "laya: this GPU is below compute capability 7.5, so torch comes from the CUDA 12.6 index (the default wheel has no kernels for it)"
  fi
  if [ -n "$index" ]; then pipi torch --index-url "https://download.pytorch.org/whl/$index"; fi
  log "laya: installing laya[serve] (a few GB with torch; the first start also downloads the checkpoint)"
  pipi 'laya[serve]'
  "$py" -c 'import laya' || { warn "laya did not import after install: continuing without it"; LAYA=0; }
}

# ---- install -----------------------------------------------------------------------------------

copy_app() {
  local target
  target="$(at "$APP_DIR")"
  if [ "$DRY_RUN" = 1 ]; then
    log "app: would copy $ENDPOINT_DIR/src to $APP_DIR/src"
    return 0
  fi
  mkdir -p "$target"
  rm -rf "$target/src.new"
  cp -R "$ENDPOINT_DIR/src" "$target/src.new"
  cp "$ENDPOINT_DIR/package.json" "$target/package.json"
  rm -rf "$target/src"
  mv "$target/src.new" "$target/src"
  log "app: copied to $APP_DIR"
}

activate_systemd() {
  local ctl=(systemctl)
  [ "$MODE" = user ] && ctl=(systemctl --user)
  "${ctl[@]}" daemon-reload
  if [ "$LAYA" = 1 ]; then "${ctl[@]}" enable --now laya.service; else "${ctl[@]}" disable --now laya.service >/dev/null 2>&1 || true; fi
  "${ctl[@]}" enable router-endpoint.service
  "${ctl[@]}" restart router-endpoint.service
  if [ "$MODE" = user ]; then
    if [ "$(loginctl show-user "$SERVICE_USER" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
      if loginctl enable-linger "$SERVICE_USER" 2>/dev/null; then
        log "linger: enabled, so the service runs at boot and after you log out"
      else
        warn "could not enable linger: the service will stop when you log out. Run: sudo loginctl enable-linger $SERVICE_USER"
      fi
    fi
  fi
}

install_systemd() {
  render_systemd_router | write_file "$UNIT_DIR/router-endpoint.service" 644
  if [ "$LAYA" = 1 ]; then render_systemd_laya | write_file "$UNIT_DIR/laya.service" 644
  elif [ "$DRY_RUN" = 0 ]; then rm -f "$(at "$UNIT_DIR/laya.service")"; fi
  if [ "$MODE" = system ] && selinux_enforcing; then
    warn "SELinux is enforcing. If the service fails with 'Permission denied' reading $APP_DIR, run: sudo restorecon -Rv /var/lib/router-endpoint /etc/router-endpoint"
  fi
  [ "$DRY_RUN" = 1 ] || [ -n "$STAGE" ] || activate_systemd
}

install_launchd() {
  render_wrapper | write_file "$RUN_WRAPPER" 755
  render_launchd dev.mmmgc.router-endpoint "$RUN_WRAPPER" router-endpoint | write_file "$UNIT_DIR/dev.mmmgc.router-endpoint.plist" 644
  if [ "$LAYA" = 1 ]; then
    render_laya_wrapper | write_file "$(dirname "$RUN_WRAPPER")/laya-run" 755
    render_launchd dev.mmmgc.laya "$(dirname "$RUN_WRAPPER")/laya-run" laya | write_file "$UNIT_DIR/dev.mmmgc.laya.plist" 644
  fi
  [ "$DRY_RUN" = 1 ] || [ -n "$STAGE" ] || {
    mkdir -p "$LOG_DIR"
    local label plist
    for label in dev.mmmgc.laya dev.mmmgc.router-endpoint; do
      plist="$UNIT_DIR/$label.plist"
      [ -f "$plist" ] || continue
      launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$plist"
    done
  }
}

install_openrc() {
  [ "$MODE" = system ] || die "OpenRC services are system-wide: use --system --run-as NAME"
  render_wrapper | write_file "$RUN_WRAPPER" 755
  render_openrc router-endpoint "$RUN_WRAPPER" "router-endpoint: one OpenAI/Anthropic model for pi and OpenCode" "laya" | write_file /etc/init.d/router-endpoint 755
  if [ "$LAYA" = 1 ]; then
    render_laya_wrapper | write_file /var/lib/router-endpoint/laya-run 755
    render_openrc laya /var/lib/router-endpoint/laya-run "Laya classifier for router-endpoint" "" | write_file /etc/init.d/laya 755
  fi
  [ "$DRY_RUN" = 1 ] || [ -n "$STAGE" ] || {
    [ "$LAYA" = 1 ] && { rc-update add laya default; rc-service laya restart; }
    rc-update add router-endpoint default
    rc-service router-endpoint restart
  }
}

install_runit() {
  [ "$MODE" = system ] || die "runit services are system-wide: use --system --run-as NAME"
  local svdir=/etc/sv scandir=/var/service
  [ -d /etc/service ] && [ ! -d /var/service ] && scandir=/etc/service
  render_wrapper | write_file "$RUN_WRAPPER" 755
  render_runit "$RUN_WRAPPER" | write_file "$svdir/router-endpoint/run" 755
  if [ "$LAYA" = 1 ]; then
    render_laya_wrapper | write_file /var/lib/router-endpoint/laya-run 755
    render_runit /var/lib/router-endpoint/laya-run | write_file "$svdir/laya/run" 755
  fi
  [ "$DRY_RUN" = 1 ] || [ -n "$STAGE" ] || {
    [ "$LAYA" = 1 ] && ln -sfn "$svdir/laya" "$scandir/laya"
    ln -sfn "$svdir/router-endpoint" "$scandir/router-endpoint"
  }
}

wait_healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS -m2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

token_from_state() {
  local state="$SERVICE_HOME/.pi/agent/router-endpoint.json"
  [ -r "$state" ] || return 1
  "$NODE_BIN" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token || "")' "$state"
}

# Keep LAYA_URL in step with whether Laya is installed, in an env file that may predate this run:
# blank when there is no Laya (no dead URL to time out on), the default when there now is one.
sync_laya_url() {
  local file
  file="$(at "$ENV_FILE")"
  [ "$DRY_RUN" = 0 ] && [ -e "$file" ] || return 0
  if [ "$LAYA" = 0 ]; then
    sed -i.bak 's#^LAYA_URL=.*#LAYA_URL=#' "$file"
  else
    sed -i.bak 's#^LAYA_URL=$#LAYA_URL=http://127.0.0.1:8787#' "$file"
  fi
  rm -f "$file.bak"
}

cmd_install() {
  find_node || die "install Node.js first (see above)"
  find_claude
  resolve_paths
  # Refuse an impossible combination before any file is written or anything is downloaded.
  case "$INIT:$MODE" in
    openrc:user) die "OpenRC services are system-wide: use --system --run-as NAME" ;;
    runit:user) die "runit services are system-wide: use --system --run-as NAME" ;;
  esac
  sudo_if_needed
  [ "$INIT" != none ] || warn "no supported init system found: files are written, but you start it yourself: $RUN_WRAPPER"
  log "installing for $DISTRO_NAME: $INIT, $MODE service as $SERVICE_USER, node $NODE_BIN"

  copy_app
  if [ "$FORCE_ENV" = 1 ] || [ ! -e "$(at "$ENV_FILE")" ] || [ "$DRY_RUN" = 1 ]; then
    render_env | write_file "$ENV_FILE" 600
    # Init systems that start a wrapper drop privileges first, so the account must be able to read it.
    if [ "$MODE" = system ] && [ "$INIT" != systemd ] && [ "$DRY_RUN" = 0 ] && [ -z "$STAGE" ]; then chown "$SERVICE_USER" "$ENV_FILE"; fi
  else
    log "env: keeping $ENV_FILE (use --force-env to rewrite)"
  fi
  install_laya
  sync_laya_url

  case "$INIT" in
    systemd) install_systemd ;;
    launchd) install_launchd ;;
    openrc) install_openrc ;;
    runit) install_runit ;;
    *) render_wrapper | write_file "$RUN_WRAPPER" 755 ;;
  esac

  [ "$DRY_RUN" = 1 ] && { log "dry run: nothing was changed"; return 0; }
  [ -z "$STAGE" ] || { log "staged under $STAGE; no service manager was touched"; return 0; }

  if wait_healthy; then
    log ""
    log "router-endpoint is up:  http://127.0.0.1:$PORT   (web UI, and the OpenAI/Anthropic API under /v1)"
    local token
    token="$(token_from_state || true)"
    [ -z "$token" ] || log "token:  $token   (clients send it as the API key; 'install.sh token' prints it again)"
  else
    warn "the service did not answer on port $PORT within 30s. Check: $(status_hint)"
    return 1
  fi
}

status_hint() {
  case "$INIT" in
    systemd) [ "$MODE" = user ] && echo "journalctl --user -u router-endpoint -e" || echo "journalctl -u router-endpoint -e" ;;
    launchd) echo "tail $SERVICE_HOME/Library/Logs/router-endpoint.log" ;;
    openrc | runit) echo "tail /var/log/router-endpoint.log" ;;
    *) echo "run $RUN_WRAPPER in a terminal" ;;
  esac
}

cmd_uninstall() {
  resolve_paths_for_uninstall
  sudo_if_needed
  case "$INIT" in
    systemd)
      local ctl=(systemctl)
      [ "$MODE" = user ] && ctl=(systemctl --user)
      if [ "$DRY_RUN" = 0 ] && [ -z "$STAGE" ]; then
        "${ctl[@]}" disable --now router-endpoint.service laya.service 2>/dev/null || true
      fi
      rm_files "$UNIT_DIR/router-endpoint.service" "$UNIT_DIR/laya.service"
      [ "$DRY_RUN" = 1 ] || [ -n "$STAGE" ] || "${ctl[@]}" daemon-reload ;;
    launchd)
      if [ "$DRY_RUN" = 0 ] && [ -z "$STAGE" ]; then
        launchctl bootout "gui/$(id -u)/dev.mmmgc.router-endpoint" 2>/dev/null || true
        launchctl bootout "gui/$(id -u)/dev.mmmgc.laya" 2>/dev/null || true
      fi
      rm_files "$UNIT_DIR/dev.mmmgc.router-endpoint.plist" "$UNIT_DIR/dev.mmmgc.laya.plist" ;;
    openrc)
      if [ "$DRY_RUN" = 0 ] && [ -z "$STAGE" ]; then
        rc-service router-endpoint stop 2>/dev/null || true; rc-update del router-endpoint 2>/dev/null || true
        rc-service laya stop 2>/dev/null || true; rc-update del laya 2>/dev/null || true
      fi
      rm_files /etc/init.d/router-endpoint /etc/init.d/laya ;;
    runit)
      rm_files /var/service/router-endpoint /var/service/laya /etc/service/router-endpoint /etc/service/laya /etc/sv/router-endpoint/run /etc/sv/laya/run ;;
  esac
  if [ "$PURGE" = 1 ]; then
    rm_files "$APP_DIR" "$ENV_FILE" "$RUN_WRAPPER" "$(dirname "$RUN_WRAPPER")/laya-run"
    [ -n "${LAYA_VENV:-}" ] || rm_files "$LAYA_DIR"
    log "purged the app, config and Laya venv; the state file (accounts, token) is kept at $SERVICE_HOME/.pi/agent/router-endpoint.json"
  else
    log "service removed; app, config and state are kept (--purge removes the app and config)"
  fi
}

resolve_paths_for_uninstall() {
  NODE_BIN="${NODE_BIN:-node}"; CLAUDE_BIN=
  resolve_paths
}

rm_files() {
  local p
  for p in "$@"; do
    if [ "$DRY_RUN" = 1 ]; then log "would remove $p"; else rm -rf "$(at "$p")"; fi
  done
}

cmd_status() {
  find_node || true
  NODE_BIN="${NODE_BIN:-node}"
  CLAUDE_BIN=
  resolve_paths
  log "service: $INIT ($MODE)"
  case "$INIT" in
    systemd)
      local ctl=(systemctl)
      [ "$MODE" = user ] && ctl=(systemctl --user)
      "${ctl[@]}" --no-pager --lines=0 status router-endpoint.service laya.service 2>&1 | sed -n '1,12p' || true ;;
  esac
  if curl -fsS -m2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then log "router:  answering on :$PORT"; else log "router:  not answering on :$PORT"; fi
  if curl -fsS -m2 "http://127.0.0.1:8787/health" >/dev/null 2>&1; then log "laya:    up"; else log "laya:    not running (classifier falls back to TypeSafe Jev, then a heuristic)"; fi
}

cmd_token() {
  find_node || exit 1
  SERVICE_HOME="${RUN_AS:+$(home_of "$RUN_AS")}"
  SERVICE_HOME="${SERVICE_HOME:-$HOME}"
  token_from_state || die "no state file yet at $SERVICE_HOME/.pi/agent/router-endpoint.json: start the service once"
  printf '\n'
}

cmd_doctor() {
  print_os
  if find_node; then log "node:      $NODE_BIN ($("$NODE_BIN" --version))"; else log "node:      MISSING"; fi
  find_claude
  log "claude:    ${CLAUDE_BIN:-missing}"
  log "uv:        $(command -v uv || echo missing)"
  log "python3:   $(command -v python3 || echo missing)"
  log "selinux:   $(selinux_enforcing && echo enforcing || echo 'not enforcing')"
  if gpu_needs_cu126; then log "gpu:       below compute capability 7.5: Laya will use the cu126 torch index"; fi
  if [ "$INIT" = systemd ] && [ "$MODE" = user ]; then
    log "linger:    $(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)"
  fi
}

# ---- main --------------------------------------------------------------------------------------

detect_platform
case "$CMD" in
  print-os) print_os ;;
  doctor) cmd_doctor ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  token) cmd_token ;;
esac
