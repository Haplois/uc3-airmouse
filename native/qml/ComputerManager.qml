import QtQuick 2.15
import QtQuick.Controls 2.15

Item {
    id: manager
    objectName: "computerManager"
    property var bridge
    property var tones
    readonly property var state: bridge.snapshot
    readonly property bool supported: state.device_management === true
    readonly property bool available: bridge.connected && !bridge.busy && pendingAction === ""
    readonly property string title: ({list: "Computers", details: "Computer", rename: "Rename computer", forget: "Forget computer"})[mode]
    property string mode: "list"
    property bool editing: false
    property string selectedId: ""
    property string pinnedName: ""
    property string draftName: ""
    property string error: ""
    property string pendingAction: ""
    property bool pairingRequested: false
    readonly property bool pairingVisible: !!state.pairing || pairingRequested
    property string dragId: ""
    property var originalOrder: []
    property real dragY: 0
    property real dragOffset: 0
    signal selectRequested(string target)
    signal managementStarted()

    ListModel { id: rows }
    function target(id) {
        var targets = state.targets || [];
        for (var i = 0; i < targets.length; i++) if (targets[i].id === id) return targets[i];
        return null;
    }
    function order() {
        var ids = [];
        for (var i = 0; i < rows.count; i++) ids.push(rows.get(i).hostId);
        return ids;
    }
    function sameMembers(a, b) { return a.slice().sort().join(",") === b.slice().sort().join(","); }
    function synchronize() {
        var targets = state.targets || [];
        var ids = targets.map(function(host) { return host.id; });
        if (dragId !== "") {
            if (sameMembers(originalOrder, ids)) return;
            dragId = ""; originalOrder = []; error = "The computer list changed. Try reordering again.";
        }
        if (pendingAction === "reorder") return;
        var sameOrder = rows.count === targets.length;
        for (var i = 0; sameOrder && i < targets.length; i++) sameOrder = rows.get(i).hostId === targets[i].id;
        if (!sameOrder) {
            rows.clear();
            for (i = 0; i < targets.length; i++) {
                var added = targets[i];
                rows.append({hostId:added.id, hostName:added.name, hostBluetoothName:added.bluetooth_name || "", hostReady:!!added.ready, hostConnected:!!added.connected});
            }
        } else {
            for (i = 0; i < targets.length; i++) {
                var host = targets[i];
                if (rows.get(i).hostName !== host.name) rows.setProperty(i,"hostName",host.name);
                if (rows.get(i).hostBluetoothName !== (host.bluetooth_name || "")) rows.setProperty(i,"hostBluetoothName",host.bluetooth_name || "");
                if (rows.get(i).hostReady !== !!host.ready) rows.setProperty(i,"hostReady",!!host.ready);
                if (rows.get(i).hostConnected !== !!host.connected) rows.setProperty(i,"hostConnected",!!host.connected);
            }
        }
        if (mode !== "list" && selectedId && !target(selectedId) && pendingAction !== "forget") {
            dismissKeyboard(); mode = "list"; error = "This computer is no longer paired.";
        }
    }
    onStateChanged: { if (state.pairing) pairingRequested = false; synchronize(); }
    Component.onCompleted: synchronize()
    Connections {
        target: manager.bridge
        function onChanged() {
            if (!manager.bridge.connected) {
                manager.dismissKeyboard(); manager.dragId = ""; manager.pendingAction = ""; manager.pairingRequested = false;
                manager.error = "Air mouse service unavailable"; manager.synchronize();
            }
        }
        function onFailed(message) {
            if (manager.pendingAction !== "") {
                manager.pendingAction = ""; manager.pairingRequested = false; manager.error = message; manager.synchronize();
            }
        }
        function onCommandSucceeded(type) {
            if (type !== manager.pendingAction) return;
            manager.pendingAction = ""; manager.error = "";
            if (type === "rename") { manager.dismissKeyboard(); manager.mode = "details"; }
            else if (type === "forget") { manager.mode = "list"; manager.selectedId = ""; }
        }
    }
    function submit(command) {
        if (!available || !supported) return;
        if (command.type === "pair") pairingRequested = true;
        else if (command.type === "cancel_pairing") pairingRequested = false;
        error = ""; pendingAction = command.type; bridge.command(command);
    }
    function dismissKeyboard() { Qt.inputMethod.hide(); renameField.focus = false; }
    function cancelInteraction() {
        dismissKeyboard(); dragId = ""; originalOrder = []; pendingAction = "";
        editing = false; mode = "list"; synchronize();
    }
    function back() {
        if (pendingAction !== "") return true;
        if (mode !== "list") { dismissKeyboard(); mode = mode === "details" ? "list" : "details"; error = ""; return true; }
        if (editing) { cancelDrag(); editing = false; return true; }
        return false;
    }
    function toggleEditing() {
        if (!available) return;
        managementStarted(); editing = !editing; error = "";
    }
    function details(id) {
        if (!available || !target(id)) return;
        managementStarted(); selectedId = id; mode = "details"; error = "";
    }
    function rename() {
        var host = target(selectedId);
        if (!available || !host) return;
        draftName = host.name; mode = "rename"; error = "";
        Qt.callLater(function() { if (manager.mode === "rename" && manager.bridge.connected) { renameField.forceActiveFocus(); Qt.inputMethod.show(); } });
    }
    function saveName(reset) {
        var name = reset ? "" : draftName.trim();
        if (!reset && !name) { error = "Enter a name or choose Use Bluetooth name."; return; }
        if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) { error = "Names cannot contain control characters."; return; }
        try {
            if (unescape(encodeURIComponent(name)).length > 48) { error = "Name is too long. Try a shorter name."; return; }
        } catch (e) { error = "Enter a valid name."; return; }
        submit({type:"rename", target:selectedId, name:name});
    }
    function confirmForget() {
        var host = target(selectedId);
        if (!available || !host) return;
        pinnedName = host.name; mode = "forget"; error = "";
    }
    function startDrag(id, y) {
        if (!available || !editing) return;
        var ids = order(); originalOrder = ids; dragId = id;
        dragY = ids.indexOf(id) * 100; dragOffset = y - dragY;
    }
    function moveDrag(y) {
        if (!dragId) return;
        dragY = Math.max(0, Math.min((rows.count - 1) * 100, y - dragOffset));
        var from = order().indexOf(dragId), to = Math.max(0, Math.min(rows.count - 1, Math.floor((dragY + 45) / 100)));
        if (from !== to) rows.move(from, to, 1);
    }
    function finishDrag() {
        if (!dragId) return;
        var ids = order(), previous = originalOrder;
        dragId = ""; originalOrder = [];
        if (ids.join(",") !== previous.join(",")) submit({type:"reorder", targets:ids});
        else synchronize();
    }
    function cancelDrag() { if (dragId) { dragId = ""; originalOrder = []; synchronize(); } }

    Item {
        visible: manager.mode === "list"; anchors.fill: parent
        Text { textFormat: Text.PlainText; x: 20; y: 24; text: manager.editing ? "Arrange your computers" : "Paired computers"; color: manager.tones.fg; font.pixelSize: 23 }
        ActionButton { objectName: "editComputersButton"; visible: manager.supported; x: parent.width - 112; y: 10; width: 92; height: 52; text: manager.editing ? "Done" : "Edit"; tones: manager.tones; enabled: manager.available; onClicked: manager.toggleEditing() }
        Text { textFormat: Text.PlainText; x: 20; y: 68; text: manager.editing ? "Drag the handle. Tap a name to edit." : "Choose where to point."; color: manager.tones.muted; font.pixelSize: 16 }
        Item {
            id: listArea
            objectName: "computerList"
            x: 20; y: 104; width: parent.width - 40; height: rows.count * 100
            Repeater {
                model: rows
                delegate: Rectangle {
                    id: row
                    objectName: "computerRow_" + hostId
                    width: listArea.width; height: 90
                    y: manager.dragId === hostId ? manager.dragY : index * 100
                    z: manager.dragId === hostId ? 10 : 0
                    radius: 16; color: manager.tones.card
                    border.color: manager.dragId === hostId || hostId === manager.state.target ? manager.tones.accent : manager.tones.line
                    border.width: manager.dragId === hostId ? 2 : 1
                    Behavior on y { enabled: manager.dragId !== hostId; NumberAnimation { duration: 100 } }
                    Button {
                        objectName: "computerSelect_" + hostId
                        width: parent.width - (manager.editing ? 56 : 0); height: parent.height
                        enabled: manager.available && manager.dragId === ""
                        Accessible.name: hostName
                        background: Item {}
                        contentItem: Item {
                            Glyph { objectName: "computerIcon_" + hostId; x: 8; anchors.verticalCenter: parent.verticalCenter; width: 30; height: 30; kind: "device"; deviceName: hostName; bluetoothName: hostBluetoothName; ink: manager.tones.accent }
                            Text { textFormat: Text.PlainText; objectName: "computerName_" + hostId; x: 50; y: 12; width: parent.width - 64; text: hostName; elide: Text.ElideRight; color: manager.tones.fg; font.pixelSize: 21 }
                            Text { textFormat: Text.PlainText; x: 50; y: 43; width: parent.width - 64; text: manager.editing ? "Rename or forget" : hostId === manager.state.target ? (hostConnected || hostReady ? "Selected · connected" : "Selected · offline") : hostConnected ? "Connected" : "Paired"; color: manager.tones.muted; font.pixelSize: 15 }
                        }
                        onClicked: manager.editing ? manager.details(hostId) : manager.selectRequested(hostId)
                    }
                    Item {
                        visible: manager.editing; anchors.right: parent.right; width: 56; height: 90
                        Column { anchors.centerIn: parent; spacing: 5; Repeater { model: 3; Rectangle { width: 22; height: 2; color: manager.tones.muted } } }
                        MouseArea {
                            objectName: "computerDrag_" + hostId
                            anchors.fill: parent; preventStealing: true; enabled: manager.available
                            onPressed: manager.startDrag(hostId, mapToItem(listArea, mouse.x, mouse.y).y)
                            onPositionChanged: if (pressed) manager.moveDrag(mapToItem(listArea, mouse.x, mouse.y).y)
                            onReleased: manager.finishDrag()
                            onCanceled: manager.cancelDrag()
                        }
                    }
                }
            }
        }
        Text { textFormat: Text.PlainText; visible: rows.count === 0; x: 30; y: 175; width: parent.width - 60; text: "No paired computers yet."; horizontalAlignment: Text.AlignHCenter; color: manager.tones.muted; font.pixelSize: 22 }
        ActionButton {
            objectName: "pairComputerButton"; visible: manager.supported
            x: 20; y: Math.max(260, listArea.y + listArea.height + 10); width: parent.width - 40; height: 56
            tones: manager.tones; primary: manager.pairingVisible
            text: manager.pairingVisible ? "Cancel pairing" : "Pair another computer"
            enabled: manager.available && (manager.pairingVisible || rows.count < (manager.state.host_limit || 4))
            onClicked: { manager.managementStarted(); manager.submit({type: manager.pairingVisible ? "cancel_pairing" : "pair"}); }
        }
        Text { textFormat: Text.PlainText; x: 20; y: Math.max(326, listArea.y + listArea.height + 76); width: parent.width - 40; text: manager.pairingVisible ? "Choose Remote 3 Air mouse on your computer." : manager.supported && rows.count >= (manager.state.host_limit || 4) ? "Four computers saved. Forget one to pair another." : ""; color: manager.tones.muted; font.pixelSize: 15; wrapMode: Text.Wrap }
    }
    Column {
        visible: manager.mode === "details"; x: 24; y: 20; width: parent.width - 48; spacing: 18
        Glyph { width: 48; height: 48; kind: "device"; deviceName: (manager.target(manager.selectedId) || {}).name || ""; bluetoothName: (manager.target(manager.selectedId) || {}).bluetooth_name || ""; ink: manager.tones.accent }
        Text { textFormat: Text.PlainText; width: parent.width; text: manager.target(manager.selectedId) ? manager.target(manager.selectedId).name : "Computer"; color: manager.tones.fg; font.pixelSize: 30; wrapMode: Text.Wrap }
        Text { textFormat: Text.PlainText; width: parent.width; text: "Bluetooth name: " + ((manager.target(manager.selectedId) || {}).bluetooth_name || "Not available"); color: manager.tones.muted; font.pixelSize: 17; wrapMode: Text.Wrap }
        ActionButton { objectName: "renameComputerButton"; width: parent.width; height: 64; text: "Rename"; tones: manager.tones; enabled: manager.available; onClicked: manager.rename() }
        ActionButton { objectName: "resetComputerNameButton"; width: parent.width; height: 64; text: "Use Bluetooth name"; tones: manager.tones; enabled: manager.available && !!(manager.target(manager.selectedId) || {}).custom_name; onClicked: manager.saveName(true) }
        ActionButton { objectName: "forgetComputerButton"; width: parent.width; height: 64; text: "Forget computer"; tones: manager.tones; enabled: manager.available; onClicked: manager.confirmForget() }
    }
    Item {
        visible: manager.mode === "rename"; anchors.fill: parent
        Text { textFormat: Text.PlainText; x: 24; y: 12; text: "Name"; color: manager.tones.muted; font.pixelSize: 17 }
        TextField {
            id: renameField; objectName: "computerRenameField"
            x: 24; y: 42; width: parent.width - 48; height: 64
            text: manager.draftName; onTextEdited: manager.draftName = text
            color: manager.tones.fg; font.pixelSize: 25; padding: 14
            inputMethodHints: Qt.ImhNoPredictiveText
            background: Rectangle { radius: 13; color: manager.tones.card; border.color: renameField.activeFocus ? manager.tones.accent : manager.tones.line }
            enabled: manager.pendingAction === "" && manager.bridge.connected
            onAccepted: Qt.inputMethod.hide()
        }
        Row {
            x: 24; y: 122; width: parent.width - 48; spacing: 12
            ActionButton { objectName: "cancelComputerRenameButton"; width: (parent.width - 12) / 2; height: 56; text: "Cancel"; tones: manager.tones; enabled: manager.pendingAction === ""; onClicked: manager.back() }
            ActionButton { objectName: "saveComputerNameButton"; width: (parent.width - 12) / 2; height: 56; text: manager.pendingAction === "rename" ? "Saving…" : "Save"; tones: manager.tones; primary: true; enabled: manager.available; onClicked: manager.saveName(false) }
        }
    }
    Column {
        visible: manager.mode === "forget"; x: 24; y: 45; width: parent.width - 48; spacing: 26
        Text { textFormat: Text.PlainText; objectName: "forgetComputerQuestion"; width: parent.width; text: "Forget “" + manager.pinnedName + "”?"; color: manager.tones.fg; font.pixelSize: 30; wrapMode: Text.Wrap }
        Text { textFormat: Text.PlainText; width: parent.width; text: "You will need to pair this computer again."; color: manager.tones.muted; font.pixelSize: 19; wrapMode: Text.Wrap }
        ActionButton { objectName: "cancelForgetComputerButton"; width: parent.width; height: 64; text: "Cancel"; tones: manager.tones; primary: true; enabled: manager.pendingAction === ""; onClicked: manager.back() }
        ActionButton { objectName: "confirmForgetComputerButton"; width: parent.width; height: 64; text: manager.pendingAction === "forget" ? "Forgetting…" : "Forget computer"; tones: manager.tones; enabled: manager.available; onClicked: manager.submit({type:"forget", target:manager.selectedId}) }
    }
    Text {
        textFormat: Text.PlainText; objectName: "computerManagementError"
        visible: manager.error !== ""; x: 24; width: parent.width - 48
        y: manager.mode === "rename" ? 198 : parent.height - height - 18
        text: manager.error; color: manager.tones.accent; font.pixelSize: 17; wrapMode: Text.Wrap
    }
}
