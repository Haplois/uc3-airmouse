// SPDX-License-Identifier: GPL-3.0-or-later
// Binds the Air mouse page to the Unfolded Circle Remote UI's Power, Battery, TouchSlider and
// ButtonNavigation internals, so it is a derivative of that GPL-3.0-or-later program.
import QtQuick 2.15
import TouchSlider 1.0
import Battery 1.0
import Power 1.0
import Power.Modes 1.0
import "qrc:/components" as Components

Item {
    id: host
    width: ui.width; height: ui.height
    property real previousX: 0
    property bool opened: false
    property bool sleeping: false
    // True while a sleep episode began with pointing enabled. The OFF sent for standby clears the
    // controller's pointer flag, so later transitions in the same episode must not read it as
    // "paused before sleep" and close the app.
    property bool keepOpenWhileSleeping: false
    signal closed()
    function handleFocusLoss() {
        if (opened && ui.inputController.activeItem !== host && !(sleeping && (keepOpenWhileSleeping || mousePage.pointerEnabled))) {
            mousePage.closeInteractions(); mousePage.endScroll(); mousePage.releaseButtons(); airMouseBridge.command({type: "off"});
        }
    }
    function open() { opened = true; navigation.takeControl(); airMouseBridge.open(); }
    function close() { if (!opened) return; opened = false; mousePage.closeInteractions(); mousePage.endScroll(); mousePage.releaseButtons(); airMouseBridge.close(); navigation.releaseControl(); closed(); }
    Component.onDestruction: { mousePage.closeInteractions(); mousePage.releaseButtons(); airMouseBridge.close(); navigation.releaseControl(); }
    AirMousePage { id: mousePage; anchors.fill: parent; bridge: airMouseBridge; batteryLevel: Battery.level; onExitRequested: host.close() }
    Components.ButtonNavigation {
        id: navigation
        defaultConfig: ({
            "BACK": { pressed: function() { mousePage.back(); }, pressed_repeat: function() {} },
            "HOME": { pressed: function() { mousePage.nextDevice(); }, pressed_repeat: function() {} },
            "POWER": { pressed: function() { mousePage.toggle(); }, pressed_repeat: function() {} },
            "PLAY": { pressed: function() { mousePage.media("play_pause"); }, pressed_repeat: function() {} },
            "PREV": { pressed: function() { mousePage.media("previous"); }, pressed_repeat: function() {} },
            "NEXT": { pressed: function() { mousePage.media("next"); }, pressed_repeat: function() {} },
            "MUTE": { pressed: function() { mousePage.media("mute"); }, pressed_repeat: function() {} },
            "VOLUME_UP": { pressed: function() { mousePage.media("volume_up"); }, pressed_repeat: function() { mousePage.media("volume_up"); } },
            "VOLUME_DOWN": { pressed: function() { mousePage.media("volume_down"); }, pressed_repeat: function() { mousePage.media("volume_down"); } },
            "STOP": { pressed: function() { mousePage.media("stop"); }, pressed_repeat: function() {} },
            "DPAD_MIDDLE": { pressed: function() { mousePage.buttonPressed(1); }, released: function() { mousePage.buttonReleased(1); }, pressed_repeat: function() {} },
            "DPAD_UP": { pressed: function() { mousePage.direction("up"); }, pressed_repeat: function() { mousePage.direction("up"); } },
            "DPAD_DOWN": { pressed: function() { mousePage.direction("down"); }, pressed_repeat: function() { mousePage.direction("down"); } },
            "DPAD_LEFT": { pressed: function() { mousePage.direction("left"); }, pressed_repeat: function() { mousePage.direction("left"); } },
            "DPAD_RIGHT": { pressed: function() { mousePage.direction("right"); }, pressed_repeat: function() { mousePage.direction("right"); } }
        })
    }
    Connections {
        target: TouchSliderProcessor
        enabled: host.opened && ui.inputController.activeItem === host
        function onTouchPressed() { host.previousX = TouchSliderProcessor.touchX; mousePage.beginScroll(); }
        function onTouchXChanged(x) { var range = TouchSliderProcessor.touchXMax - TouchSliderProcessor.touchXMin; mousePage.scroll((x - host.previousX) / (range > 0 ? range : 300)); host.previousX = x; }
        function onTouchReleased() { mousePage.endScroll(); }
    }
    Connections {
        target: ui.inputController
        function onActiveItemChanged() {
            Qt.callLater(host.handleFocusLoss);
        }
    }
    // Power policy. Idle (display off) never closes the app and keeps an enabled pointer running,
    // so the remote can be used without its screen; the service's own idle timeout still pauses a
    // motionless pointer. Low power and suspend interrupt Bluetooth and sensor acquisition: they
    // pause pointing and keep the app open when the sleep episode began with pointing enabled,
    // and close a paused app otherwise.
    Connections {
        target: Power
        function onPowerModeChanged(fromMode, toMode) {
            var wasSleeping = host.sleeping;
            host.sleeping = toMode !== PowerModes.Normal;
            if (toMode === PowerModes.Normal) { host.keepOpenWhileSleeping = false; return; }
            if (!wasSleeping) host.keepOpenWhileSleeping = mousePage.pointerEnabled;
            if (toMode === PowerModes.Idle) { mousePage.endScroll(); mousePage.releaseButtons(); return; }
            if (!host.keepOpenWhileSleeping) { host.close(); return; }
            mousePage.endScroll(); mousePage.releaseButtons();
            if (mousePage.pointerEnabled) airMouseBridge.command({type: "off", reason: "Paused for standby"});
        }
    }
}
