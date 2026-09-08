import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "Palette.js" as Palettes

Rectangle {
    id: page
    objectName: "airMousePage"
    width: 480; height: 800
    property var bridge
    property int batteryLevel: 0
    property string timeText: Qt.formatTime(new Date(), "hh:mm")
    readonly property var viewState: bridge.snapshot
    readonly property var palette: Palettes.get(viewState.theme)
    readonly property bool pointing: bridge.connected && !!viewState.pointer
    readonly property bool pointerEnabled: pointing || bridge.connected && viewState.pointer_enabled === true
    readonly property bool swapClickButtons: viewState.swap_click_buttons === true
    property string screenPage: "mouse"
    property string notice: ""
    property bool touching: false
    property real wheelFraction: 0
    property int physicalButtons: 0
    property int touchButtons: 0
    property int heldButtons: 0
    readonly property bool canPair: viewState.bluetooth_backend === "owned" && !viewState.paired
    signal exitRequested()
    color: palette.bg
    onPointingChanged: { if (!pointing) { endScroll(); releaseButtons(); } }
    onScreenPageChanged: { releaseButtons(); Qt.inputMethod.hide(); }
    Timer { interval: 30000; repeat: true; running: true; onTriggered: page.timeText = Qt.formatTime(new Date(), "hh:mm") }
    Connections { target: page.bridge; function onFailed(message) { page.notice = message; noticeTimer.restart(); } }
    Timer { id: noticeTimer; interval: 4500; onTriggered: page.notice = "" }

    function send(command) { bridge.command(command); }
    function dismissKeyboard() {
        Qt.inputMethod.hide();
        if (screenPage === "targets" && pageContent.item) pageContent.item.dismissKeyboard();
    }
    function closeInteractions() {
        dismissKeyboard();
        if (screenPage === "targets" && pageContent.item) pageContent.item.cancelInteraction();
    }
    function navigate(destination) {
        closeInteractions();
        endScroll();
        releaseButtons();
        if (destination === "calibrate" || pointerEnabled || viewState.switching || viewState.calibrating || bridge.busy) send({type: "off", reason: destination === "calibrate" ? "Paused for calibration" : destination === "targets" ? "Paused to choose a device" : "Paused for Settings"});
        screenPage = destination;
    }
    function back() {
        if (screenPage === "targets" && pageContent.item && pageContent.item.back()) return;
        if (screenPage === "colors" || screenPage === "calibrate") navigate("settings");
        else if (screenPage !== "mouse") navigate("mouse");
        else { endScroll(); releaseButtons(); send({type: "off"}); exitRequested(); }
    }
    function toggle() {
        if (screenPage !== "mouse") return;
        if (pointing) releaseButtons();
        send({type: pointerEnabled ? "off" : "on"});
    }
    function nextDevice() {
        if (screenPage !== "mouse" || !bridge.connected || bridge.busy) return;
        var devices = (viewState.targets || []).slice(0, 3);
        if (!devices.length) return;
        var selected = -1;
        for (var i = 0; i < devices.length; i++) if (devices[i].id === viewState.target) selected = i;
        endScroll(); releaseButtons();
        send({type: "target", target: devices[(selected + 1) % devices.length].id, keep_pointer: true});
    }
    function media(key) {
        if (screenPage !== "mouse" || !bridge.connected || bridge.busy || !viewState.ready) return;
        send({type: "media", key: key});
    }
    function direction(key) {
        if (screenPage !== "mouse" || !bridge.connected || bridge.busy || !viewState.ready) return;
        send({type: "key", key: key});
    }
    function buttonPressed(button, touchscreen) {
        if (button !== 1 && button !== 2) return;
        if ((touchscreen ? touchButtons : physicalButtons) & button) return;
        if (touchscreen) touchButtons |= button;
        else physicalButtons |= button;
        if (screenPage !== "mouse") return;
        if (!pointing) { notice = "Start pointing to click"; noticeTimer.restart(); return; }
        if (viewState.button_edges !== true) { click(button); return; }
        if (heldButtons & button) return;
        heldButtons |= button;
        send({type: "button", button: button, down: true});
    }
    function buttonReleased(button, touchscreen) {
        if (button !== 1 && button !== 2) return;
        if (touchscreen) touchButtons &= ~button;
        else physicalButtons &= ~button;
        if ((physicalButtons | touchButtons) & button) return;
        if (!(heldButtons & button)) return;
        heldButtons &= ~button;
        if (bridge.connected) send({type: "button", button: button, down: false});
    }
    function releaseButtons() {
        var held = heldButtons;
        physicalButtons = 0;
        touchButtons = 0;
        heldButtons = 0;
        if (!bridge || !bridge.connected) return;
        for (var button = 1; button <= 2; button++) {
            if (held & button) send({type: "button", button: button, down: false});
        }
    }
    function click(button) {
        if (screenPage !== "mouse") return;
        if (!pointing) { notice = "Start pointing to click"; noticeTimer.restart(); return; }
        send({type: "click", button: button});
    }
    function beginScroll() {
        if (screenPage !== "mouse" || !pointing) { notice = "Start pointing to scroll"; noticeTimer.restart(); return; }
        touching = true; wheelFraction = 0;
    }
    function scroll(delta) { if (touching && pointing) wheelFraction = Math.max(-3, Math.min(3, wheelFraction + delta * 20)); }
    function endScroll() { touching = false; wheelFraction = 0; }
    Timer {
        interval: 25; repeat: true; running: page.touching && page.pointing
        onTriggered: {
            if (page.bridge.busy || Math.abs(page.wheelFraction) < 1) return;
            var direction = page.wheelFraction > 0 ? 1 : -1;
            page.wheelFraction -= direction; page.send({type: "scroll", direction: direction});
        }
    }
    function statusText() {
        if (!bridge.connected) return "Air mouse service unavailable";
        if (viewState.error) return viewState.error;
        if (viewState.ownership_status && !viewState.core_connected) return viewState.ownership_status;
        if (!viewState.core_connected) return "Bluetooth service unavailable";
        if (viewState.switching) return pointerEnabled ? "Connecting · pointing stays on" : "Connecting · pointer paused";
        if (viewState.pairing) return "Pairing · choose Air mouse on your computer";
        if (canPair) return "Pair your computer to get started";
        if (pointing) return touching ? "Scrolling" : "Pointing is on";
        if (viewState.stop_reason && viewState.stop_reason.indexOf("Paused") === 0) return viewState.stop_reason + " · press Power";
        if (!viewState.target) return "Choose a paired computer";
        if (!viewState.ready) return "Target unavailable · reconnect Bluetooth";
        return "Connected · pointer paused";
    }

    Text { textFormat: Text.PlainText; x: 28; y: 19; text: page.timeText; color: page.palette.fg; font.pixelSize: 15; font.bold: true }
    Text { textFormat: Text.PlainText; anchors.right: parent.right; anchors.rightMargin: 28; y: 19; text: page.batteryLevel + "%"; color: page.palette.muted; font.pixelSize: 15 }
    Item {
        x: 25; y: 49; width: parent.width - 50; height: 71
        ActionButton { objectName: "backButton"; width: 56; height: 56; anchors.verticalCenter: parent.verticalCenter; tones: page.palette; glyph: "back"; Accessible.name: "Back"; onClicked: page.back() }
        Text { textFormat: Text.PlainText; anchors.centerIn: parent; text: page.screenPage === "targets" && pageContent.item ? pageContent.item.title : ({mouse:"Air mouse", settings:"Settings", colors:"Color theme", targets:"Computer", calibrate:"Calibrate"})[page.screenPage]; color: page.palette.fg; font.pixelSize: 26; font.weight: Font.DemiBold }
        ActionButton { objectName: "settingsButton"; width: 56; height: 56; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; visible: page.screenPage === "mouse"; tones: page.palette; glyph: "settings"; Accessible.name: "Settings"; onClicked: page.navigate("settings") }
    }
    Loader {
        id: pageContent
        x: 0; y: 120; width: parent.width; height: parent.height - 120
        sourceComponent: ({mouse: mouseView, settings: settingsView, colors: colorsView, targets: targetsView, calibrate: calibrateView})[page.screenPage]
    }
    Component {
        id: mouseView
        Item {
            Column {
                x: 20; y: 20; width: parent.width - 40; spacing: 0
                Item {
                    width: parent.width; height: 262
                    Button {
                        objectName: "monitorButton"
                        anchors.horizontalCenter: parent.horizontalCenter; width: 260; height: 134
                        enabled: page.pointerEnabled || page.bridge.connected && page.viewState.ready && !page.bridge.busy
                        Accessible.name: page.pointerEnabled ? "Pause pointing" : "Start pointing"
                        onClicked: page.toggle()
                        background: Rectangle {
                            radius: 19; border.color: parent.activeFocus ? page.palette.accent : page.palette.line
                            opacity: parent.down ? 0.7 : 1
                            gradient: Gradient { GradientStop { position: 0; color: page.palette.monitor } GradientStop { position: 1; color: page.palette.card } }
                        }
                        contentItem: Item { Glyph { anchors.centerIn: parent; width: 60; height: 60; kind: page.pointerEnabled ? "pointer" : "pause"; ink: page.palette.accent } }
                        Rectangle { anchors.top: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; width: 58; height: 13; color: "transparent"; border.color: page.palette.line }
                    }
                    Text { textFormat: Text.PlainText; y: 160; width: parent.width; text: page.viewState.target_name || "Choose a computer"; color: page.palette.fg; horizontalAlignment: Text.AlignHCenter; font.pixelSize: 36; elide: Text.ElideRight }
                    Text { textFormat: Text.PlainText; y: 208; width: parent.width; text: page.statusText(); color: page.palette.muted; horizontalAlignment: Text.AlignHCenter; font.pixelSize: 18; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight }
                }
                Rectangle {
                    width: parent.width; height: 250; radius: 25; color: page.palette.card; border.color: page.palette.line
                    Text { textFormat: Text.PlainText; x: 20; y: 35; text: "QUICK SWITCH"; color: page.palette.muted; font.pixelSize: 14 }
                    ActionButton { objectName: "allDevicesButton"; anchors.right: parent.right; anchors.rightMargin: 20; y: 15; width: 158; height: 56; text: page.canPair && !page.viewState.device_management ? "Pair computer" : "All devices ›"; textSize: 16; tones: page.palette; enabled: page.bridge.connected && !page.bridge.busy; onClicked: page.canPair && !page.viewState.device_management ? page.send({type: "pair"}) : page.navigate("targets") }
                    Row {
                        x: 20; y: 86; width: parent.width - 40; spacing: 10
                        Repeater {
                            model: (page.viewState.targets || []).slice(0, 3)
                            delegate: Button {
                                objectName: "quickTarget" + index
                                width: (parent.width - 20) / 3; height: 144
                                readonly property bool chosen: modelData.id === page.viewState.target
                                enabled: page.bridge.connected && !page.bridge.busy
                                Accessible.name: modelData.name
                                background: Rectangle { color: chosen ? page.palette.accent : page.palette.bg; radius: 15; border.color: page.palette.line; border.width: parent.activeFocus ? 2 : 1 }
                                contentItem: Item {
                                  Column {
                                    objectName: "quickTargetContents"
                                    anchors.centerIn: parent; width: parent.width
                                    spacing: 8
                                    Glyph { objectName: "quickTargetIcon" + index; width: 32; height: 32; anchors.horizontalCenter: parent.horizontalCenter; kind: "device"; deviceName: modelData.name || ""; bluetoothName: modelData.bluetooth_name || ""; ink: chosen ? page.palette.ink : page.palette.fg }
                                    Text { textFormat: Text.PlainText; width: parent.width; height: 44; text: modelData.name; color: chosen ? page.palette.ink : page.palette.fg; font.pixelSize: 17; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight }
                                    Text { textFormat: Text.PlainText; anchors.horizontalCenter: parent.horizontalCenter; text: chosen ? "Selected" : modelData.ready ? "Ready" : "Offline"; font.pixelSize: 14; color: chosen ? page.palette.ink : page.palette.muted }
                                }
                                }
                                onClicked: {
                                    page.endScroll(); page.releaseButtons();
                                    page.send(chosen ? {type: "disconnect"} : {type: "target", target: modelData.id, keep_pointer: true});
                                }
                            }
                        }
                    }
                    Text { textFormat: Text.PlainText; visible: !(page.viewState.targets || []).length; x: 20; y: 120; width: parent.width - 40; text: page.canPair ? (page.viewState.device_management ? "No paired computers.\nOpen All devices to pair." : "No paired computer.\nTap Pair computer to connect.") : "No paired mouse targets.\nPair a computer in Bluetooth settings."; color: page.palette.muted; font.pixelSize: 19; horizontalAlignment: Text.AlignHCenter }
                }
            }
            Row {
                objectName: "mouseButtons"
                anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
                anchors.bottomMargin: 0
                height: 120; spacing: 0
                Repeater {
                    model: page.swapClickButtons ? [2, 1] : [1, 2]
                    ActionButton {
                        readonly property int mouseButton: modelData
                        objectName: mouseButton === 1 ? "leftClickButton" : "rightClickButton"
                        width: parent.width / 2; height: parent.height; cornerRadius: 0
                        text: mouseButton === 1 ? "Left click" : "Right click"; textSize: 22; tones: page.palette
                        background: Rectangle { color: page.palette.card; opacity: parent.down ? 0.7 : 1 }
                        enabled: page.pointing
                        onPressed: page.buttonPressed(mouseButton, true)
                        onReleased: page.buttonReleased(mouseButton, true)
                        onCanceled: page.buttonReleased(mouseButton, true)
                    }
                }
            }
        }
    }
    Component {
        id: settingsView
        Flickable {
            clip: true; contentHeight: settingsColumn.height + 36; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { }
            Column {
                id: settingsColumn; x: 29; y: 18; width: parent.width - 58; spacing: 15
                Text { textFormat: Text.PlainText; text: "Make it feel right."; color: page.palette.fg; font.pixelSize: 33 }
                ActionButton {
                    width: parent.width; text: "Color theme"; tones: page.palette
                    enabled: !page.bridge.busy; onClicked: page.navigate("colors")
                    Accessible.name: "Color theme, " + page.palette.name
                    contentItem: RowLayout {
                        Text { textFormat: Text.PlainText; text: "Color theme"; color: page.palette.fg; font.pixelSize: 18; Layout.fillWidth: true }
                        Text { textFormat: Text.PlainText; text: page.palette.name; color: page.palette.muted; font.pixelSize: 18 }
                        Glyph { kind: "next"; ink: page.palette.fg; width: 24; height: 24 }
                    }
                }
                Text { textFormat: Text.PlainText; text: "Click button order"; color: page.palette.fg; font.pixelSize: 17 }
                Row {
                    width: parent.width; spacing: 8
                    Repeater {
                        model: [false, true]
                        ActionButton {
                            objectName: modelData ? "buttonOrderSwapped" : "buttonOrderNormal"
                            width: (parent.width - 8) / 2; height: 56; tones: page.palette
                            text: modelData ? "Right · Left" : "Left · Right"
                            primary: page.swapClickButtons === modelData
                            enabled: page.bridge.connected && !page.bridge.busy && !page.pointing && !page.viewState.calibrating
                            onClicked: if (!primary) page.send({type: "swap_click_buttons", swapped: modelData})
                        }
                    }
                }
                Text { textFormat: Text.PlainText; text: "Pointer speed"; color: page.palette.fg; font.pixelSize: 17 }
                RateSlider {
                    tones: page.palette;
                    objectName: "speedSlider"; width: parent.width; from: 10; to: 100; stepSize: 1; settingValue: page.viewState.speed || 60; pending: page.bridge.busy; enabled: page.bridge.connected && !page.bridge.busy
                    onPressedChanged: if (!pressed) page.send({type: "speed", speed: Math.round(value)})
                    onMoved: if (!pressed) page.send({type: "speed", speed: Math.round(value)})
                    ToolTip.visible: pressed; ToolTip.text: Math.round(value) + "%"
                }
                Row { width: parent.width; Text { textFormat: Text.PlainText; width: parent.width / 2; text: "Precise"; color: page.palette.muted; font.pixelSize: 12 } Text { textFormat: Text.PlainText; width: parent.width / 2; text: "Fast"; horizontalAlignment: Text.AlignRight; color: page.palette.muted; font.pixelSize: 12 } }
                Row { width: parent.width; Text { textFormat: Text.PlainText; width: parent.width / 2; text: "Output limit"; color: page.palette.fg; font.pixelSize: 17 } Text { textFormat: Text.PlainText; width: parent.width / 2; text: Math.round(outputSlider.value) + " Hz"; horizontalAlignment: Text.AlignRight; color: page.palette.accent; font.pixelSize: 15 } }
                RateSlider {
                    tones: page.palette; id: outputSlider; objectName: "outputSlider"; width: parent.width; from: 10; to: 1000; stepSize: 10; settingValue: page.viewState.output_rate || 500; pending: page.bridge.busy; enabled: page.bridge.connected && !page.bridge.busy; onPressedChanged: if (!pressed) page.send({type: "output_rate", rate: Math.round(value)}); onMoved: if (!pressed) page.send({type: "output_rate", rate: Math.round(value)}) }
                Text { textFormat: Text.PlainText; width: parent.width; text: "Requested limit. Delivery depends on device support and connection."; color: page.palette.muted; font.pixelSize: 13; wrapMode: Text.Wrap }
                Row { width: parent.width; Text { textFormat: Text.PlainText; width: parent.width * 0.6; text: "Requested sampling"; color: page.palette.fg; font.pixelSize: 16 } Text { textFormat: Text.PlainText; width: parent.width * 0.4; text: (page.viewState.sampling_policy ? page.viewState.sampling_policy.requested : "—") + " Hz"; color: page.palette.accent; horizontalAlignment: Text.AlignRight; font.pixelSize: 15 } }
                Text { textFormat: Text.PlainText; width: parent.width; text: "Automatic · at least 2× output, rounded up.\n" + (page.viewState.sampling_policy && !page.viewState.sampling_policy.satisfied ? "Installed driver cannot meet this setting." : ""); color: page.palette.muted; font.pixelSize: 13; wrapMode: Text.Wrap }
                Row { width: parent.width; Text { textFormat: Text.PlainText; width: parent.width / 2; text: "Applied sampling"; color: page.palette.fg; font.pixelSize: 14 } Text { textFormat: Text.PlainText; width: parent.width / 2; text: page.viewState.applied_sampling ? page.viewState.applied_sampling + " Hz" : "Inactive"; color: page.palette.muted; horizontalAlignment: Text.AlignRight; font.pixelSize: 14 } }
                Row { width: parent.width; Text { textFormat: Text.PlainText; width: parent.width / 2; text: "Host report rate"; color: page.palette.fg; font.pixelSize: 14 } Text { textFormat: Text.PlainText; width: parent.width / 2; text: "Unmeasured"; color: page.palette.muted; horizontalAlignment: Text.AlignRight; font.pixelSize: 14 } }
                ActionButton { objectName: "calibrateButton"; width: parent.width; text: "Calibrate on a flat surface"; tones: page.palette; enabled: page.bridge.connected && !page.bridge.busy; onClicked: page.navigate("calibrate") }
                Text { textFormat: Text.PlainText; text: "Bluetooth ownership"; color: page.palette.fg; font.pixelSize: 17 }
                Row {
                    objectName: "ownershipRow"; width: parent.width; spacing: 8
                    Repeater {
                        model: [["always", "Always"], ["session", "While open"], ["never", "Never"]]
                        ActionButton {
                            objectName: "ownership_" + modelData[0]
                            width: (parent.width - 16) / 3; height: 52; textSize: 15; tones: page.palette
                            primary: page.viewState.bluetooth_ownership === modelData[0]
                            text: modelData[1]
                            enabled: page.bridge.connected && !page.bridge.busy && !page.pointing
                            onClicked: if (page.viewState.bluetooth_ownership !== modelData[0]) page.send({type: "bluetooth_ownership", mode: modelData[0]})
                        }
                    }
                }
                Text { textFormat: Text.PlainText; width: parent.width; text: ({always: "The remote's own mouse stack runs from boot. Stock Bluetooth remotes stay off.", session: "Takes over Bluetooth when this app opens and hands it back a few seconds after it closes.", never: "Stock Bluetooth only. Clicks are complete presses and computers pair in the firmware settings."})[page.viewState.bluetooth_ownership] || ""; color: page.palette.muted; font.pixelSize: 13; wrapMode: Text.Wrap }
                Text { textFormat: Text.PlainText; visible: !!page.viewState.ownership_status; width: parent.width; text: page.viewState.ownership_status || ""; color: page.palette.accent; font.pixelSize: 13; wrapMode: Text.Wrap }
            }
        }
    }
    Component {
        id: colorsView
        Item {
        Column {
            x: 29; y: 18; width: parent.width - 58; spacing: 24
            Text { textFormat: Text.PlainText; text: "Choose your color."; color: page.palette.fg; font.pixelSize: 33 }
            Text { textFormat: Text.PlainText; text: "All six themes use a dark background."; color: page.palette.muted; font.pixelSize: 17 }
            Grid {
                width: parent.width; columns: 2; spacing: 14
                Repeater {
                    model: Palettes.names
                    delegate: Button {
                        objectName: "theme_" + modelData
                        width: (parent.width - 14) / 2; height: 118; enabled: page.bridge.connected && !page.bridge.busy
                        readonly property var choice: Palettes.get(modelData)
                        readonly property bool chosen: page.viewState.theme === modelData
                        Accessible.name: choice.name
                        background: Rectangle { color: page.palette.card; radius: 18; border.color: chosen ? page.palette.accent : page.palette.line; border.width: chosen ? 2 : 1 }
                        contentItem: Item {
                            Rectangle { x: 10; y: 10; width: 32; height: 32; radius: 16; color: modelData === "black" ? "black" : choice.accent; border.color: "#888888" }
                            Glyph { visible: chosen; anchors.right: parent.right; anchors.rightMargin: 10; y: 15; width: 21; height: 21; kind: "check"; ink: page.palette.accent }
                            Text { textFormat: Text.PlainText; x: 10; y: 65; text: choice.name; color: page.palette.fg; font.pixelSize: 17 }
                        }
                        onClicked: page.send({type: "theme", theme: modelData})
                    }
                }
            }
            ActionButton { width: parent.width; height: 80; text: "Done"; tones: page.palette; primary: true; onClicked: page.navigate("settings") }
        }
        }
    }
    Component {
        id: targetsView
        ComputerManager {
            bridge: page.bridge; tones: page.palette
            onSelectRequested: { page.send({type: "target", target: target}); page.screenPage = "mouse"; }
            onManagementStarted: { page.endScroll(); page.releaseButtons(); if (page.pointing) page.send({type: "off"}); }
        }
    }
    Component {
        id: calibrateView
        Item {
        Column {
            x: 29; y: 60; width: parent.width - 58; spacing: 30
            Rectangle { anchors.horizontalCenter: parent.horizontalCenter; width: 170; height: 170; radius: 85; color: "transparent"; border.color: page.palette.line; Glyph { anchors.centerIn: parent; width: 70; height: 70; kind: page.viewState.stop_reason === "Calibration complete" ? "check" : "calibrate"; ink: page.palette.accent } }
            Text { textFormat: Text.PlainText; width: parent.width; text: page.viewState.calibrating ? "Keep it still." : page.viewState.stop_reason === "Calibration complete" ? "All set." : "Find a flat surface."; horizontalAlignment: Text.AlignHCenter; color: page.palette.fg; font.pixelSize: 33 }
            Text { textFormat: Text.PlainText; width: parent.width; text: page.viewState.calibrating ? "Learning the resting position." : "Put the remote down.\nPointing stays paused."; horizontalAlignment: Text.AlignHCenter; color: page.palette.muted; font.pixelSize: 17 }
            ActionButton { objectName: "startCalibrationButton"; width: parent.width; height: 80; tones: page.palette; primary: true; text: page.viewState.stop_reason === "Calibration complete" ? "Back to Settings" : "Start calibration"; enabled: page.bridge.connected && !page.bridge.busy; onClicked: page.viewState.stop_reason === "Calibration complete" ? page.navigate("settings") : page.send({type: "calibrate"}) }
        }
        }
    }
    Rectangle {
        visible: page.notice !== ""; x: 29; width: parent.width - 58; height: message.implicitHeight + 28; anchors.bottom: parent.bottom; anchors.bottomMargin: 105; radius: 13; color: page.palette.card; border.color: page.palette.accent; z: 10
        Text { textFormat: Text.PlainText; id: message; anchors.centerIn: parent; width: parent.width - 28; text: page.notice; color: page.palette.fg; font.pixelSize: 16; wrapMode: Text.Wrap; horizontalAlignment: Text.AlignHCenter }
    }
}
