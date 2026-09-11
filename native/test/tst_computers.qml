import QtQuick 2.15
import QtTest 1.2
import "../qml"

TestCase {
    id: test
    name: "ComputerManagement"
    width: 480; height: 800; visible: true
    when: windowShown
    property var manager
    QtObject {
        id: bridge
        property var snapshot: ({theme:"black",ready:false,targets:[]})
        property bool connected: true
        property bool busy: false
        property var commands: []
        signal failed(string message)
        signal commandSucceeded(string type)
        function command(value) { commands.push(value); busy=true; }
    }
    AirMousePage { id: page; bridge: bridge; batteryLevel: 82 }
    Glyph { id: deviceGlyph; visible: false; width: 24; height: 24; kind: "device" }
    Rectangle {
        id: iconGallery; visible: false; width: 480; height: 120; color: "#101014"
        Row {
            anchors.centerIn: parent
            Repeater {
                model: ["desktop","ipad","iphone","android","phone","laptop","lg-tv"]
                delegate: Item {
                    width: 66; height: 92
                    Glyph { anchors.horizontalCenter: parent.horizontalCenter; width: 42; height: 42; kind: modelData; ink: "#f5f1ff" }
                    Text { anchors.bottom: parent.bottom; width: parent.width; text: modelData; color: "#bbb4c8"; font.pixelSize: 13; horizontalAlignment: Text.AlignHCenter }
                }
            }
        }
    }
    function hosts() {
        return [
            {id:"00000001",name:"Work laptop",bluetooth_name:"MacBook Pro",custom_name:"Work laptop",ready:true,connected:true},
            {id:"00000002",name:"Living room PC",bluetooth_name:"Living room PC",custom_name:"",ready:false,connected:false},
            {id:"00000003",name:"Studio",bluetooth_name:"Studio",custom_name:"",ready:false,connected:false},
            {id:"00000004",name:"Travel laptop",bluetooth_name:"Travel laptop",custom_name:"",ready:false,connected:false}
        ];
    }
    function update(values) {
        var next=JSON.parse(JSON.stringify(bridge.snapshot));
        for (var key in values) next[key]=values[key];
        bridge.snapshot=next;
    }
    function init() {
        bridge.connected=true; bridge.busy=false;
        page.navigate("mouse");
        bridge.snapshot=({theme:"black",device_management:true,host_limit:4,bluetooth_backend:"owned",button_edges:true,paired:true,pairing:false,pointer:false,core_connected:true,ready:true,target:"00000001",target_name:"Work laptop",targets:hosts(),speed:60,output_rate:80});
        bridge.commands=[]; page.notice=""; wait(20);
    }
    function openManager() {
        page.navigate("targets"); wait(20);
        manager=findChild(page,"computerManager"); verify(manager);
    }
    function openRename() {
        openManager();
        mouseClick(findChild(manager,"editComputersButton"));
        mouseClick(findChild(manager,"computerSelect_00000001"));
        mouseClick(findChild(manager,"renameComputerButton")); wait(20);
        compare(manager.mode,"rename");
    }
    function enterName(text) {
        var field=findChild(manager,"computerRenameField");
        field.forceActiveFocus(); keyClick(Qt.Key_A,Qt.ControlModifier);
        for (var i=0;i<text.length;i++) keyClick(text[i]);
        compare(manager.draftName,text);
    }
    function complete(type, values) { if (values) update(values); bridge.busy=false; bridge.commandSucceeded(type); }
    function test_pair_capacity_and_cancel() {
        openManager();
        var button=findChild(manager,"pairComputerButton");
        compare(button.enabled,false);
        update({targets:hosts().slice(0,3)}); compare(button.enabled,true);
        mouseClick(button); compare(bridge.commands,[{type:"pair"}]);
        complete("pair",{pairing:true}); compare(button.text,"Cancel pairing");
        mouseClick(button); compare(bridge.commands[1],{type:"cancel_pairing"});
    }
    function test_pair_lg_profile_and_cancel() {
        openManager();
        var lg=findChild(manager,"pairLGTVButton"); compare(lg.enabled,false);
        update({targets:hosts().slice(0,3)}); verify(lg.enabled); mouseClick(lg);
        compare(bridge.commands,[{type:"pair_lg"}]); compare(manager.pairingLG,true);
        complete("pair_lg",{pairing:true}); compare(lg.visible,false);
        mouseClick(findChild(manager,"pairComputerButton"));
        compare(bridge.commands[1],{type:"cancel_pairing"});
    }
    function test_pair_ack_does_not_flash_idle_state() {
        openManager(); update({targets:hosts().slice(0,3)});
        var button=findChild(manager,"pairComputerButton");
        mouseClick(button); compare(button.enabled,false);
        bridge.busy=false; bridge.commandSucceeded("pair");
        compare(button.text,"Cancel pairing");
        update({pairing:true}); compare(button.text,"Cancel pairing");
    }
    function test_cancel_before_pairing_status_clears_starting_state() {
        openManager(); update({targets:hosts().slice(0,3)});
        var button=findChild(manager,"pairComputerButton");
        mouseClick(button); bridge.busy=false; bridge.commandSucceeded("pair");
        mouseClick(button);
        compare(bridge.commands[1],{type:"cancel_pairing"});
        compare(manager.pairingRequested,false);
    }
    function test_pairing_heartbeat_keeps_row_delegates_alive() {
        openManager();
        var row=findChild(manager,"computerRow_00000001"); verify(row);
        update({pairing:true});
        compare(findChild(manager,"computerRow_00000001"),row);
        update({pairing:true});
        compare(findChild(manager,"computerRow_00000001"),row);
    }
    function test_rename_save_waits_for_ack_and_preserves_draft() {
        openRename(); enterName("Desk");
        var changed=hosts(); changed[0].bluetooth_name="New Bluetooth name";
        update({targets:changed}); compare(manager.draftName,"Desk");
        mouseClick(findChild(manager,"saveComputerNameButton"));
        compare(bridge.commands,[{type:"rename",target:"00000001",name:"Desk"}]);
        compare(manager.mode,"rename");
        changed[0].custom_name=changed[0].name="Desk";
        complete("rename",{targets:changed}); compare(manager.mode,"details");
    }
    function test_rename_cancel_and_reset() {
        openRename(); enterName("Discard");
        mouseClick(findChild(manager,"cancelComputerRenameButton"));
        compare(manager.mode,"details"); compare(bridge.commands.length,0);
        mouseClick(findChild(manager,"resetComputerNameButton"));
        compare(bridge.commands,[{type:"rename",target:"00000001",name:""}]);
    }
    function test_rename_error_stays_visible_and_accepts_retry() {
        openRename(); enterName("Desk");
        mouseClick(findChild(manager,"saveComputerNameButton"));
        bridge.busy=false; bridge.failed("Saving the name failed");
        compare(manager.mode,"rename"); compare(manager.error,"Saving the name failed");
        compare(manager.draftName,"Desk"); verify(findChild(manager,"saveComputerNameButton").enabled);
    }
    function test_utf8_limits_and_control_characters() {
        openRename(); manager.draftName="é".repeat(25); manager.saveName(false);
        compare(bridge.commands.length,0); verify(manager.error.length>0);
        manager.draftName="Desk\nname"; manager.saveName(false); compare(bridge.commands.length,0);
        manager.draftName="é".repeat(24); manager.saveName(false); compare(bridge.commands.length,1);
    }
    function test_forget_confirmation_pins_id_and_name() {
        openManager(); mouseClick(findChild(manager,"editComputersButton"));
        mouseClick(findChild(manager,"computerSelect_00000002"));
        mouseClick(findChild(manager,"forgetComputerButton"));
        compare(bridge.commands.length,0); compare(manager.mode,"forget");
        var changed=hosts().reverse(); changed[2].name="Changed later"; update({targets:changed});
        compare(manager.pinnedName,"Living room PC");
        mouseClick(findChild(manager,"cancelForgetComputerButton")); compare(bridge.commands.length,0);
        mouseClick(findChild(manager,"forgetComputerButton"));
        mouseClick(findChild(manager,"confirmForgetComputerButton"));
        compare(bridge.commands,[{type:"forget",target:"00000002"}]); compare(manager.mode,"forget");
        bridge.busy=false; bridge.failed("Could not forget computer"); compare(manager.mode,"forget");
        mouseClick(findChild(manager,"confirmForgetComputerButton"));
        complete("forget",{targets:hosts().filter(function(host){return host.id!=="00000002";})});
        compare(manager.mode,"list");
    }
    function test_drag_handle_sends_one_permutation_and_failure_restores() {
        openManager(); mouseClick(findChild(manager,"editComputersButton"));
        var handle=findChild(manager,"computerDrag_00000001");
        var position=handle.mapToItem(page,28,45);
        mousePress(page,position.x,position.y);
        compare(manager.dragId,"00000001");
        mouseMove(page,position.x,position.y+110,30);
        mouseMove(page,position.x,position.y+210,30);
        compare(bridge.commands.length,0);
        mouseRelease(page,position.x,position.y+210);
        compare(bridge.commands,[{type:"reorder",targets:["00000002","00000003","00000001","00000004"]}]);
        compare(manager.mode,"list");
        bridge.busy=false; bridge.failed("Saving the order failed");
        compare(manager.order(),hosts().map(function(host){return host.id;}));
    }
    function test_drag_ignores_order_updates_and_cancels_membership_change() {
        openManager(); mouseClick(findChild(manager,"editComputersButton"));
        manager.startDrag("00000001",45); manager.moveDrag(255);
        var during=manager.order(); update({targets:hosts().reverse()});
        compare(manager.order(),during); compare(manager.dragId,"00000001");
        update({targets:hosts().slice(0,3)}); compare(manager.dragId,"");
        manager.finishDrag(); compare(bridge.commands.length,0);
        compare(manager.order(),["00000001","00000002","00000003"]);
    }
    function test_first_three_follow_authoritative_order() {
        var changed=hosts().reverse(); update({targets:changed}); wait(20);
        for (var i=0;i<3;i++) compare(findChild(page,"quickTarget"+i).Accessible.name,changed[i].name);
        verify(!findChild(page,"quickTarget3"));
    }
    function test_device_icons_follow_bluetooth_names() {
        var cases = [
            ["TV", "[LG] webOS TV OLED77G3PSA", "lg-tv"],
            ["Living room", "LG webOS TV OLED55C3", "lg-tv"],
            ["Office", "DESKTOP-ABC", "desktop"],
            ["Renamed iPad", "DESKTOP-ABC", "desktop"],
            ["Tablet", "Alex’s iPad", "ipad"],
            ["Mobile", "Jamie iPhone", "iphone"],
            ["Mobile", "Pixel 9 Pro", "android"],
            ["Travel", "Generic phone", "phone"],
            ["Work", "MacBook Pro", "laptop"]
        ];
        for (var i=0;i<cases.length;i++) {
            deviceGlyph.deviceName=cases[i][0]; deviceGlyph.bluetoothName=cases[i][1];
            compare(deviceGlyph.resolvedKind,cases[i][2]);
        }
        compare(findChild(page,"quickTargetIcon0").resolvedKind,"laptop");
        openManager();
        compare(findChild(manager,"computerIcon_00000001").resolvedKind,"laptop");
    }
    function test_hostnames_are_plain_text() {
        var changed=hosts(); changed[0].name="<b>Desk</b>"; update({targets:changed,target_name:changed[0].name});
        openManager(); var label=findChild(manager,"computerName_00000001");
        compare(label.textFormat,Text.PlainText); compare(label.text,"<b>Desk</b>");
        manager.details("00000001"); manager.confirmForget();
        compare(findChild(manager,"forgetComputerQuestion").textFormat,Text.PlainText);
    }
    function test_disconnect_clears_pending_actions_and_allows_reconnect() {
        openManager();
        manager.pendingAction = "rename";
        manager.pairingRequested = true;
        manager.dragId = "00000001";
        bridge.connected = false;
        compare(manager.pendingAction, "");
        compare(manager.pairingRequested, false);
        compare(manager.dragId, "");
        verify(manager.error.length > 0);
        bridge.connected = true;
        verify(manager.available);
        compare(manager.back(), false);
    }
    function test_back_and_disconnect_clear_editor_focus() {
        openRename(); var field=findChild(manager,"computerRenameField"); verify(field.activeFocus);
        page.back(); compare(manager.mode,"details"); compare(field.activeFocus,false);
        manager.rename(); wait(20); verify(field.activeFocus);
        bridge.connected=false; compare(field.activeFocus,false); verify(manager.error.length>0);
    }
    function test_v1_fallback_selects_without_management() {
        update({device_management:false}); openManager();
        compare(findChild(manager,"editComputersButton").visible,false);
        compare(findChild(manager,"pairComputerButton").visible,false);
        mouseClick(findChild(manager,"computerSelect_00000002"));
        compare(bridge.commands,[{type:"target",target:"00000002"}]); compare(page.screenPage,"mouse");
    }
    function test_render_screens() {
        iconGallery.visible=true; grabImage(iconGallery).save("/tmp/airmouse-devices/native-device-icons.png"); iconGallery.visible=false;
        grabImage(page).save("/tmp/airmouse-devices/native-home.png");
        openManager(); grabImage(page).save("/tmp/airmouse-devices/native-computers.png");
        mouseClick(findChild(manager,"editComputersButton"));
        grabImage(page).save("/tmp/airmouse-devices/native-computers-edit.png");
        manager.details("00000001"); grabImage(page).save("/tmp/airmouse-devices/native-computer-details.png");
        manager.rename(); wait(20); grabImage(page).save("/tmp/airmouse-devices/native-rename.png");
        manager.back(); manager.confirmForget(); grabImage(page).save("/tmp/airmouse-devices/native-forget.png");
    }
}
