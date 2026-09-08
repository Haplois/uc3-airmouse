#!/bin/sh
set -eu

root=${AIRMOUSE_DEPLOY_ROOT:-}
base=$root/mnt/data/airmouse/bluetooth
transaction=$root/run/airmouse-bluetooth-takeover
runtime=$root/run/systemd/system
units=$root/etc/systemd/system
stock_mask=$runtime/btstack.service
helper_mask=$runtime/btuart.service
dropin=$runtime/airmouse.service.d/80-owned-bluetooth.conf
gpio=$root/sys/class/gpio/gpio28
uart=$root/dev/ttyS1
firmware=$root/opt/uc/bt/fw/init/BCM4373A0_001.001.025.0103.0155.FCC.CE.2BC.hcd
wrapper=$base/owned-bluetooth.sh
request_file=$root/run/airmouse/bluetooth-request
request_failed=$root/run/airmouse/bluetooth-request.failed
command=${1:-status}

fail() { echo "$*" >&2; exit 1; }
active() { systemctl is-active --quiet "$1"; }
stopped() {
    state=$(systemctl show --property=ActiveState --value "$1") || return 1
    case "$state" in inactive|failed) return 0 ;; *) return 1 ;; esac
}
uart_idle() {
    if [ -z "$root" ] && command -v fuser >/dev/null 2>&1; then
        if fuser -s "$uart"; then
            echo 'Bluetooth UART is still open' >&2; return 1
        else
            result=$?
            if [ "$result" = 1 ]; then return 0; fi
            echo 'Could not inspect Bluetooth UART ownership' >&2; return 1
        fi
    fi
    for fd in "$root"/proc/[0-9]*/fd/*; do
        target=$(readlink "$fd" 2>/dev/null || true)
        if [ "$target" = "$uart" ] || [ "$target" = /dev/ttyS1 ]; then
            echo "Bluetooth UART is still open: $fd" >&2; return 1
        fi
    done
}
power_off() {
    test -w "$gpio/value" || return 1
    printf '0\n' > "$gpio/value"
}
power_on() {
    test -f "$transaction/prepared" || fail 'No prepared Bluetooth takeover'
    test "$(readlink "$stock_mask")" = /dev/null || fail 'Stock Bluetooth must remain runtime-masked'
    test "$(readlink "$helper_mask")" = /dev/null || fail 'Bluetooth UART helper must remain runtime-masked'
    stopped btstack.service || fail 'Stock Bluetooth is still running'
    stopped btuart.service || fail 'Bluetooth UART helper is still running'
    uart_idle || return 1
    test -w "$gpio/value" && test -w "$gpio/direction" || fail 'Bluetooth GPIO is not exported and writable'
    printf '0\n' > "$gpio/value"
    sleep 0.1
    printf 'out\n' > "$gpio/direction"
    printf '1\n' > "$gpio/value"
}
save_file() {
    source_path=$1; saved_path=$2
    if [ -e "$source_path" ] || [ -L "$source_path" ]; then
        cp -a "$source_path" "$saved_path"
    else
        touch "$saved_path.absent"
    fi
}
restore_file() {
    saved_path=$1; destination=$2
    if [ -f "$saved_path.absent" ]; then
        rm -f "$destination"
    else
        test -e "$saved_path" || test -L "$saved_path" || return 1
        rm -f "$destination"
        cp -a "$saved_path" "$destination"
    fi
}
rollback() {
    systemctl stop airmouse-bluetooth-guard.timer >/dev/null 2>&1 || true
    test -d "$transaction" || return 0
    if [ ! -f "$transaction/prepared" ]; then
        rm -rf "$transaction"
        return 0
    fi
    systemctl stop airmouse.service || return 1
    systemctl stop airmouse-bluetooth-probe.service >/dev/null 2>&1 || true
    systemctl stop airmouse-bluetooth.service || return 1
    stopped airmouse-bluetooth.service || return 1
    if stopped btstack.service; then
        if [ -f "$transaction/helper-active" ]; then
            systemctl stop btuart.service || return 1
            stopped btuart.service || return 1
        fi
        uart_idle || return 1
        power_off || return 1
    elif ! active btstack.service; then
        return 1
    fi
    restore_file "$transaction/stock-mask" "$stock_mask" || return 1
    if [ -f "$transaction/helper-active" ]; then
        restore_file "$transaction/helper-mask" "$helper_mask" || return 1
    fi
    restore_file "$transaction/node-dropin" "$dropin" || return 1
    systemctl daemon-reload || return 1
    systemctl reset-failed btstack.service airmouse-bluetooth.service >/dev/null 2>&1 || true
    if [ -f "$transaction/helper-active" ] && [ "$(cat "$transaction/helper-active")" = yes ]; then
        systemctl reset-failed btuart.service >/dev/null 2>&1 || true
        systemctl start btuart.service || return 1
        active btuart.service || return 1
    fi
    if [ "$(cat "$transaction/stock-active")" = yes ]; then
        systemctl start btstack.service || return 1
        active btstack.service || return 1
    fi
    if [ "$(cat "$transaction/node-active")" = yes ]; then
        systemctl start airmouse.service || return 1
        active airmouse.service || return 1
    fi
    rm -rf "$transaction"
    echo 'Stock Bluetooth and previous air mouse service state restored.'
}
transaction_failed() {
    result=$?
    trap - EXIT HUP INT TERM
    if ! rollback; then
        echo 'Rollback incomplete. Transaction record retained; run rollback again.' >&2
        result=1
    fi
    exit "$result"
}
prepare() {
    test ! -e "$transaction" || fail 'A takeover record already exists; run rollback first'
    stopped airmouse-bluetooth.service || fail 'Owned Bluetooth is already running'
    test -x "$base/current/bin/airmouse-hid" || fail 'Install the Bluetooth bundle first'
    test -r "$firmware" || fail 'Installed Bluetooth firmware is missing'
    test -w "$gpio/value" && test -w "$gpio/direction" || fail 'Bluetooth GPIO is not exported and writable'
    mkdir -m 0700 "$transaction"
    trap transaction_failed EXIT
    trap 'exit 1' HUP INT TERM
    if active btstack.service; then echo yes; else echo no; fi > "$transaction/stock-active"
    if active btuart.service; then echo yes; else echo no; fi > "$transaction/helper-active"
    if active airmouse.service; then echo yes; else echo no; fi > "$transaction/node-active"
    systemctl is-enabled btstack.service > "$transaction/stock-enabled" 2>/dev/null || true
    systemctl is-enabled btuart.service > "$transaction/helper-enabled" 2>/dev/null || true
    mkdir -p "$runtime/airmouse.service.d"
    save_file "$stock_mask" "$transaction/stock-mask"
    save_file "$helper_mask" "$transaction/helper-mask"
    save_file "$dropin" "$transaction/node-dropin"
    touch "$transaction/prepared"
    systemd-run --quiet --collect --unit=airmouse-bluetooth-guard --on-active=45s /bin/sh "$wrapper" rollback
    systemctl mask --runtime btstack.service
    systemctl mask --runtime btuart.service
    systemctl stop airmouse.service
    test ! -f "$root/mnt/data/airmouse/state/sensor-journal.json" || fail 'Sensor recovery must complete before Bluetooth takeover'
    systemctl stop btstack.service
    stopped btstack.service || fail 'Stock Bluetooth did not stop'
    systemctl stop btuart.service
    stopped btuart.service || fail 'Bluetooth UART helper did not stop'
    uart_idle || fail 'Cannot take ownership of Bluetooth UART'
}
install_bundle() {
    release=${2:-}
    case "$release" in ''|*[!a-f0-9]*) fail 'Invalid Bluetooth release ID' ;; esac
    test "${#release}" = 16 || fail 'Invalid Bluetooth release ID'
    test ! -e "$transaction" || fail 'Roll back the active takeover before installing'
    stopped airmouse-bluetooth.service || fail 'Stop owned Bluetooth before installing'
    getent passwd uccore >/dev/null || fail 'uccore user is missing'
    getent group airmouse >/dev/null || fail 'Install the air mouse runtime first'
    source_dir=$base/releases/$release
    test -x "$source_dir/bin/airmouse-hid" || fail 'Release daemon is missing'
    if [ -e "$base/current" ] && [ ! -L "$base/current" ]; then fail 'Current Bluetooth release must be a symlink'; fi
    mkdir -p "$base/install-backup" "$units"
    backup=$base/install-backup/$(date +%s)-$$
    mkdir -m 0700 "$backup"
    save_file "$base/current" "$backup/current"
    save_file "$wrapper" "$backup/wrapper"
    save_file "$units/airmouse-bluetooth.service" "$backup/daemon-unit"
    save_file "$units/airmouse-bluetooth-rollback.service" "$backup/rollback-unit"
    save_file "$units/airmouse-bluetooth-request.path" "$backup/request-path"
    save_file "$units/airmouse-bluetooth-request.service" "$backup/request-unit"
    install_failed() {
        result=$?; trap - EXIT HUP INT TERM
        restore_file "$backup/current" "$base/current" || true
        restore_file "$backup/wrapper" "$wrapper" || true
        restore_file "$backup/daemon-unit" "$units/airmouse-bluetooth.service" || true
        restore_file "$backup/rollback-unit" "$units/airmouse-bluetooth-rollback.service" || true
        restore_file "$backup/request-path" "$units/airmouse-bluetooth-request.path" || true
        restore_file "$backup/request-unit" "$units/airmouse-bluetooth-request.service" || true
        systemctl daemon-reload || true
        exit "$result"
    }
    trap install_failed EXIT
    trap 'exit 1' HUP INT TERM
    install -d -o uccore -g airmouse -m 0700 "$base/state"
    install -m 0755 "$source_dir/deploy/owned-bluetooth.sh" "$wrapper"
    install -m 0644 "$source_dir/deploy/airmouse-bluetooth.service" "$units/airmouse-bluetooth.service"
    install -m 0644 "$source_dir/deploy/airmouse-bluetooth-rollback.service" "$units/airmouse-bluetooth-rollback.service"
    install -m 0644 "$source_dir/deploy/airmouse-bluetooth-request.path" "$units/airmouse-bluetooth-request.path"
    install -m 0644 "$source_dir/deploy/airmouse-bluetooth-request.service" "$units/airmouse-bluetooth-request.service"
    ln -s "releases/$release" "$base/current.new"
    mv -Tf "$base/current.new" "$base/current"
    printf '%s\n' "$base/current" "$wrapper" "$units/airmouse-bluetooth.service" "$units/airmouse-bluetooth-rollback.service" "$units/airmouse-bluetooth-request.path" "$units/airmouse-bluetooth-request.service" "$base/state" "$source_dir" > "$backup/installed-files"
    systemctl daemon-reload
    # The path unit is the only boot-enabled piece: it lets the unprivileged service request ownership changes.
    systemctl enable --now airmouse-bluetooth-request.path
    trap - EXIT HUP INT TERM
    echo "Installed Bluetooth release $release. Daemon remains disabled; request watcher enabled; backups: $backup"
}

if [ -z "$root" ]; then test "$(id -u)" = 0 || fail 'Run as root'; fi
case "$command" in
    power-on) power_on; exit ;;
    power-off) power_off; exit ;;
    request)
        # Invoked by airmouse-bluetooth-request.path as root. The file holds exactly one word.
        # Runs before the operation lock because it re-invokes this script, which takes the lock itself.
        test -f "$request_file" || exit 0
        kind=$(head -c 16 "$request_file" | tr -d '[:space:]')
        rm -f "$request_file"
        case "$kind" in
            takeover)
                if [ -f "$transaction/prepared" ] && active airmouse-bluetooth.service; then rm -f "$request_failed"; exit 0; fi
                if sh "$wrapper" takeover 2>"$request_failed.tmp"; then rm -f "$request_failed" "$request_failed.tmp"
                else
                    reason=$(tail -n 1 "$request_failed.tmp"); rm -f "$request_failed.tmp"
                    printf '%s\n' "${reason:-Bluetooth takeover failed}" > "$request_failed"; exit 1
                fi
                exit ;;
            rollback)
                if [ ! -f "$transaction/prepared" ]; then exit 0; fi
                sh "$wrapper" rollback || exit 1
                # A requested release is expected; do not hold future automatic takeovers.
                rm -f "$request_failed"
                ;;
            *) fail "Unknown Bluetooth ownership request: $kind" ;;
        esac
        exit ;;
esac
mkdir -p "$root/run/lock"
exec 9>"$root/run/lock/airmouse-bluetooth.lock"
flock -w 100 9 || fail 'Another Bluetooth operation is still running'
case "$command" in
    install) install_bundle "$@" ;;
    probe)
        prepare
        if systemd-run --quiet --wait --pipe --collect --unit=airmouse-bluetooth-probe \
            -p User=uccore -p Group=airmouse -p RuntimeDirectory=airmouse-bluetooth-probe \
            -p RuntimeDirectoryMode=0700 -p RuntimeMaxSec=20 -p TimeoutStopSec=2 \
            -p "ExecStartPre=+/bin/sh $wrapper power-on" \
            -p "ExecStopPost=+/bin/sh $wrapper power-off" \
            "$base/current/bin/airmouse-hid" --probe --socket /run/airmouse-bluetooth-probe/control.sock \
            --state-dir /run/airmouse-bluetooth-probe --firmware "$firmware" > "$transaction/probe.log" 2>&1; then
            :
        else
            cat "$transaction/probe.log" >&2
            fail 'Controller probe failed'
        fi
        cat "$transaction/probe.log"
        grep -qx PROBE_OK "$transaction/probe.log" || fail 'Controller probe did not report PROBE_OK'
        rollback
        trap - EXIT HUP INT TERM
        ;;
    takeover)
        prepare
        printf '[Service]\nEnvironment=AIRMOUSE_OUTPUT=owned\n' > "$dropin"
        systemctl daemon-reload
        systemctl reset-failed airmouse-bluetooth.service >/dev/null 2>&1 || true
        systemctl start airmouse-bluetooth.service || fail 'Owned Bluetooth did not start'
        active airmouse-bluetooth.service || fail 'Owned Bluetooth did not start'
        if [ "$(cat "$transaction/node-active")" = yes ]; then
            systemctl start airmouse.service
            active airmouse.service || fail 'Air mouse runtime did not start'
        fi
        systemctl stop airmouse-bluetooth-guard.timer
        trap - EXIT HUP INT TERM
        echo 'Owned Bluetooth is active until rollback or reboot. Pair through the native Air mouse page.'
        ;;
    rollback)
        rollback
        # An explicit rollback holds automatic takeovers until the app is opened again.
        mkdir -p "$(dirname "$request_failed")"; printf 'Bluetooth released by rollback\n' > "$request_failed"
        ;;
    status)
        for unit in btstack.service btuart.service airmouse-bluetooth.service airmouse.service; do
            systemctl show "$unit" --property=ActiveState --property=SubState --property=UnitFileState
        done
        if [ -f "$transaction/prepared" ]; then echo 'Runtime takeover record present'; else echo 'No runtime takeover record'; fi
        ;;
    *) fail 'Expected install, probe, takeover, rollback, request, status, power-on, or power-off' ;;
esac
