#!/bin/sh
set -eu
root=${AIRMOUSE_SLEEP_ROOT:-}
state=$root/run/airmouse-sleep
restore() {
    result=0
    if test -f "$state/bluetooth"; then
        if ! test -f "$root/run/airmouse-bluetooth-takeover/prepared" ||
                systemctl --no-block start airmouse-bluetooth.service; then
            rm -f "$state/bluetooth"
        else
            result=1
        fi
    fi
    if test -f "$state/node"; then
        if systemctl --no-block start airmouse.service; then
            rm -f "$state/node"
        else
            result=1
        fi
    fi
    rmdir "$state" 2>/dev/null || true
    return "$result"
}
case "${1:-}" in
    pre)
        mkdir -p "$state"
        chmod 700 "$state"
        if systemctl is-active --quiet airmouse.service; then
            touch "$state/node"
            systemctl stop airmouse.service
        fi
        if test -f "$root/run/airmouse-bluetooth-takeover/prepared" && systemctl is-active --quiet airmouse-bluetooth.service; then
            touch "$state/bluetooth"
            systemctl stop airmouse-bluetooth.service
        fi
        ;;
    post)
        restore
        ;;
    *) exit 2 ;;
esac
