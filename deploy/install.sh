#!/bin/sh
set -eu
base=${AIRMOUSE_BASE:-/mnt/data/airmouse}
run_dir=${AIRMOUSE_RUN_DIR:-/run/airmouse}
unit_dir=${AIRMOUSE_UNIT_DIR:-/etc/systemd/system}
release=$1
case "$release" in *[!a-zA-Z0-9._-]*|'') exit 2;; esac
new="$base/releases/$release"
unit="$unit_dir/airmouse.service"
mkdir -p "$base"
exec 9>"$base/install.lock"
flock -n 9
for file in runtime/main.mjs runtime/bluetooth-journal.mjs runtime/permissions.mjs deploy/ready.mjs deploy/airmouse.service config/airmouse.json; do
  test -f "$new/$file"
done
for file in "$new/runtime/"*.mjs "$new/deploy/"*.mjs; do node --check "$file"; done
previous=
if test -L "$base/current"; then
  previous=$(readlink "$base/current")
  case "$previous" in releases/*) test -f "$base/$previous/runtime/main.mjs";; *) exit 2;; esac
elif test -e "$base/current"; then
  echo 'Current release must be a symlink' >&2
  exit 2
fi
was_active=0
was_enabled=0
if systemctl is-active --quiet airmouse.service; then was_active=1; fi
if systemctl is-enabled --quiet airmouse.service; then was_enabled=1; fi
backup=$(mktemp -d "$base/.install.XXXXXX")
if test -f "$unit"; then cp -p "$unit" "$backup/airmouse.service"; fi
drop_in="$unit_dir/airmouse.service.d/sensor.conf"
if test -f "$drop_in"; then cp -p "$drop_in" "$backup/sensor.conf"; fi
stopped=0
restore_drop_in() {
  if test -f "$backup/sensor.conf"; then
    mkdir -p "$unit_dir/airmouse.service.d" && cp -p "$backup/sensor.conf" "$drop_in"
  else
    rm -f "$drop_in"
    rmdir "$unit_dir/airmouse.service.d" 2>/dev/null || true
  fi
}
rollback() {
  if test -f "$unit" || test -n "$previous"; then systemctl stop airmouse.service || return 1; fi
  if test -f "$base/state/sensor-journal.json"; then
    echo 'Sensor recovery is unresolved; automatic release restoration stopped' >&2
    return 1
  fi
  if test -n "$previous"; then
    ln -sfn "$previous" "$base/current.new" && mv -Tf "$base/current.new" "$base/current" || return 1
  else
    AIRMOUSE_UNIT_DIR="$unit_dir" node "$new/runtime/permissions.mjs" restore || return 1
    rm -f "$base/current" || return 1
  fi
  if test "$was_enabled" = 0 && test -f "$unit"; then systemctl disable airmouse.service || return 1; fi
  if test -f "$backup/airmouse.service"; then
    cp -p "$backup/airmouse.service" "$unit" || return 1
  else
    rm -f "$unit" || return 1
  fi
  restore_drop_in || return 1
  systemctl daemon-reload || return 1
  if test "$was_enabled" = 1; then systemctl enable airmouse.service || return 1; fi
  if test "$was_active" = 1; then
    rm -f "$base/state/status.json" || return 1
    systemctl reset-failed airmouse.service || true
    systemctl start airmouse.service || return 1
    node "$new/deploy/ready.mjs" "$base/state" || return 1
    systemctl is-active --quiet airmouse.service || return 1
  fi
}
finish() {
  code=$?
  trap - 0 1 2 15
  if test "$code" != 0 && test "$stopped" = 1; then
    if rollback; then echo 'Installation failed; prior release and service state restored' >&2
    else echo "Installation recovery incomplete; backup retained at $backup" >&2; exit "$code"; fi
  fi
  rm -rf "$backup"
  exit "$code"
}
trap finish 0
trap 'exit 130' 1 2 15
if ! id airmouse >/dev/null 2>&1; then
  getent group airmouse >/dev/null 2>&1 || addgroup -S airmouse
  adduser -S -D -H -G airmouse -s /bin/false airmouse
fi
mkdir -p "$base/state" "$run_dir"
chown airmouse:airmouse "$base/state" "$run_dir"
chmod 700 "$base/state" "$run_dir"
mkdir -p "$base/ui"
chown airmouse:ucui "$base/ui"
chmod 2750 "$base/ui"
stopped=1
if test -f "$unit" || test -n "$previous"; then systemctl stop airmouse.service; fi
test ! -f "$base/state/sensor-journal.json"
if test ! -f "$base/state/airmouse.json"; then
  cp "$new/config/airmouse.json" "$base/state/airmouse.json"
  chown airmouse:airmouse "$base/state/airmouse.json"
  chmod 600 "$base/state/airmouse.json"
fi
AIRMOUSE_UNIT_DIR="$unit_dir" node "$new/runtime/permissions.mjs" prepare
node "$new/runtime/bluetooth-journal.mjs" "$base/state"
chown airmouse:airmouse "$base/state/bluetooth-journal.json"
ln -sfn "releases/$release" "$base/current.new"
mv -Tf "$base/current.new" "$base/current"
cp "$new/deploy/airmouse.service" "$unit"
rm -f "$base/state/status.json"
systemctl daemon-reload
systemctl reset-failed airmouse.service || true
systemctl enable airmouse.service
systemctl start airmouse.service
node "$new/deploy/ready.mjs" "$base/state"
systemctl is-active --quiet airmouse.service
if test -n "$previous"; then printf '%s\n' "$previous" > "$base/previous"; fi
