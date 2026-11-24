#!/usr/bin/env bash
# Runs a project's Floorplan map as an always-on login service (Linux / WSL with systemd):
# the map is served at http://127.0.0.1:<port>/ and watch.mjs keeps it current as the code changes.
#
#   tools/service/install.sh <project-root> [--port 4378] [--name <name>] [--full-at 03:30|off] [--windows-autostart]
#   tools/service/install.sh --uninstall --name <name>
#
# --windows-autostart (WSL only): adds a hidden entry to the Windows Startup folder that starts this WSL distro at
# Windows sign-in, so systemd (and this service) is running without opening a terminal.
set -euo pipefail

port=4378; name=""; full_at="03:30"; win=0; uninstall=0; root=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --full-at) full_at="$2"; shift 2 ;;
    --windows-autostart) win=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) root="$1"; shift ;;
  esac
done

unit_dir="$HOME/.config/systemd/user"
if [ "$uninstall" = 1 ]; then
  [ -n "$name" ] || { echo "--uninstall needs --name" >&2; exit 1; }
  systemctl --user disable --now "floorplan-$name.service" 2>/dev/null || true
  rm -f "$unit_dir/floorplan-$name.service"
  systemctl --user daemon-reload
  echo "removed floorplan-$name.service"
  exit 0
fi

[ -n "$root" ] || { echo "usage: $0 <project-root> [--port N] [--name NAME]" >&2; exit 1; }
root="$(cd "$root" && pwd)"
[ -n "$name" ] || name="$(basename "$root" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-\n' '-')"
here="$(cd "$(dirname "$0")/../.." && pwd)"
skill="$here/skills/floorplan"
node_bin="$(command -v node)" || { echo "node is not on PATH" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is not available here" >&2; exit 1; }

mkdir -p "$unit_dir"
cat > "$unit_dir/floorplan-$name.service" <<EOF
[Unit]
Description=Floorplan map of $root (http://127.0.0.1:$port/), kept current as the code changes
After=default.target

[Service]
WorkingDirectory=$root
ExecStart=$node_bin $skill/scripts/watch.mjs $root --serve --port $port --full-at $full_at
Restart=always
RestartSec=10
Environment=PATH=$(dirname "$node_bin"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=FLOORPLAN_NO_PROMPTS=1
Nice=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "floorplan-$name.service"
# start with the user's systemd even when nobody is logged in
if command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" 2>/dev/null || echo "! could not enable linger: run 'sudo loginctl enable-linger $USER' so it starts at boot"
fi
echo "floorplan-$name.service enabled: http://127.0.0.1:$port/  (logs: journalctl --user -u floorplan-$name -f)"

if [ "$win" = 1 ]; then
  [ -n "${WSL_DISTRO_NAME:-}" ] || { echo "! --windows-autostart only applies inside WSL" >&2; exit 0; }
  winprofile="$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")"
  startup="$winprofile/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"
  [ -d "$startup" ] || { echo "! Windows Startup folder not found" >&2; exit 1; }
  # one hidden wsl.exe that stays open keeps the distro (and its systemd services) running
  printf 'CreateObject("WScript.Shell").Run "wsl.exe -d %s --exec /bin/sleep infinity", 0, False\r\n' "$WSL_DISTRO_NAME" > "$startup/WSL services ($WSL_DISTRO_NAME).vbs"
  echo "Windows sign-in now starts WSL $WSL_DISTRO_NAME hidden: $startup/WSL services ($WSL_DISTRO_NAME).vbs"
fi
