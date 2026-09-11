import QtQuick 2.15
import QtTest 1.2

TestCase {
    id: test
    name: "PhysicalButtons"
    width: 480; height: 800; visible: true
    when: windowShown
    property var host
    property var navigation
    QtObject {
        id: bridge
        property var snapshot: ({theme:"black",pointer:true,button_edges:true,ready:true,core_connected:true,targets:[]})
        property bool connected: true
        property bool busy: false
        property var commands: []
        property int closes: 0
        property int reconnects: 0
        signal failed(string message)
        signal commandSucceeded(string type)
        function command(value) { commands.push(value); }
        function open() {}
        function reconnect() { reconnects++; }
        function close() { closes++; }
    }
    QtObject {
        id: inputController
        property var activeItem
    }
    QtObject {
        id: ui
        property int width: 480
        property int height: 800
        property var inputController: inputController
    }
    QtObject {
        id: slider
        property real touchX: 0
        property real touchXMin: 0
        property real touchXMax: 300
        signal touchPressed()
        signal touchReleased()
    }
    QtObject {
        id: power
        signal powerModeChanged(int fromMode, int toMode)
    }
    property var airMouseBridge: bridge
    property var mockSlider: slider
    property var mockPower: power
    function test_wake_reconnects_immediately_only_while_open() {
        host.open();
        var before = bridge.reconnects;
        host.resumeFromSleep();
        compare(bridge.reconnects,before+1);
        host.close();
        host.resumeFromSleep();
        compare(bridge.reconnects,before+1);
    }
    function initTestCase() {
        var request = new XMLHttpRequest();
        request.open("GET", Qt.resolvedUrl("../qml/AirMouseHost.qml"), false);
        request.send();
        var source = request.responseText;
        verify(source.indexOf("Components.ButtonNavigation") >= 0);
        source = source.replace(/import (TouchSlider|Battery|Power|Power.Modes) 1.0\n/g, "");
        source = source.replace('import "qrc:/components" as Components', 'import "' + Qt.resolvedUrl("../qml") + '"');
        source = source.replace("Components.ButtonNavigation {", 'Item { objectName: "navigation"; property var defaultConfig; function takeControl() {} function releaseControl() {}');
        source = source.replace(/Battery.level/g, "82").replace(/TouchSliderProcessor/g, "mockSlider");
        source = source.replace("target: Power", "target: mockPower").replace(/PowerModes.Normal/g, "0").replace(/PowerModes.Idle/g, "1").replace(/PowerModes.Low_power/g, "2");
        host = Qt.createQmlObject(source, test, "testable-AirMouseHost.qml");
        navigation = findChild(host,"navigation");
        verify(navigation);
    }
    function init() {
        host.close();
        host.sleeping=false; host.keepOpenWhileSleeping=false;
        findChild(host,"airMousePage").screenPage="mouse";
        bridge.snapshot=({theme:"black",pointer:true,button_edges:true,ready:true,core_connected:true,targets:[]});
        bridge.commands=[]; bridge.closes=0; bridge.busy=true;
        inputController.activeItem=host;
        host.open();
    }
    function cleanupTestCase() { host.destroy(); }
    function test_close_hides_keyboard_and_clears_editor() {
        bridge.busy=false;
        bridge.snapshot=({theme:"black",pointer:false,button_edges:true,device_management:true,ready:true,core_connected:true,targets:[{id:"00000001",name:"Desk",bluetooth_name:"Desk",custom_name:""}]});
        var page=findChild(host,"airMousePage"); page.navigate("targets"); wait(20);
        var manager=findChild(page,"computerManager"); manager.details("00000001"); manager.rename(); wait(20);
        var field=findChild(manager,"computerRenameField"); verify(field.activeFocus);
        host.close(); compare(field.activeFocus,false); compare(manager.mode,"list");
    }
    function test_ok_remains_left_click() {
        var state=JSON.parse(JSON.stringify(bridge.snapshot)); state.swap_click_buttons=true; bridge.snapshot=state;
        var config=navigation.defaultConfig;
        config.DPAD_MIDDLE.pressed(); config.DPAD_MIDDLE.pressed(); config.DPAD_MIDDLE.pressed_repeat();
        config.DPAD_MIDDLE.released();
        compare(bridge.commands,[{type:"button",button:1,down:true},{type:"button",button:1,down:false}]);
    }
    function test_directions_send_arrow_keys_while_paused() {
        bridge.busy=false;
        bridge.snapshot=({theme:"black",pointer:false,ready:true,targets:[]});
        var keys=["UP","DOWN","LEFT","RIGHT"];
        for (var i=0;i<keys.length;i++) {
            var binding=navigation.defaultConfig["DPAD_"+keys[i]];
            binding.pressed(); binding.pressed_repeat();
            compare(bridge.commands[i*2],{type:"key",key:keys[i].toLowerCase()});
            compare(bridge.commands[i*2+1],bridge.commands[i*2]);
        }
        bridge.busy=true; navigation.defaultConfig.DPAD_UP.pressed();
        bridge.busy=false; findChild(host,"airMousePage").screenPage="settings";
        navigation.defaultConfig.DPAD_RIGHT.pressed();
        compare(bridge.commands.length,8);
    }
    function test_home_cycles_quick_devices_without_closing() {
        bridge.busy=false;
        bridge.snapshot=({theme:"black",pointer:true,button_edges:true,ready:true,core_connected:true,target:"a",targets:[{id:"a",name:"A"},{id:"b",name:"B"},{id:"c",name:"C"},{id:"d",name:"D"}]});
        navigation.defaultConfig.DPAD_MIDDLE.pressed();
        navigation.defaultConfig.HOME.pressed();
        compare(bridge.commands[1],{type:"button",button:1,down:false});
        compare(bridge.commands[2],{type:"target",target:"b",keep_pointer:true});
        compare(bridge.closes,0); compare(host.opened,true);
        navigation.defaultConfig.DPAD_MIDDLE.released(); compare(bridge.commands.length,3);
        var next=JSON.parse(JSON.stringify(bridge.snapshot)); next.target="c"; next.pointer=false; bridge.snapshot=next;
        navigation.defaultConfig.HOME.pressed();
        compare(bridge.commands[3],{type:"target",target:"a",keep_pointer:true});
        navigation.defaultConfig.HOME.pressed_repeat(); compare(bridge.commands.length,4);
    }
    function test_lg_physical_remote_buttons() {
        bridge.busy=false;
        bridge.snapshot=({theme:"black",target_profile:"lg-tv",pointer:false,button_edges:true,ready:true,core_connected:true,targets:[]});
        var config=navigation.defaultConfig;
        config.HOME.pressed(); config.BACK.pressed();
        config.DPAD_MIDDLE.pressed(); config.DPAD_MIDDLE.released();
        config.NEXT.pressed(); config.PREV.pressed();
        compare(bridge.commands,[{type:"key",key:"home"},{type:"key",key:"back"},{type:"key",key:"ok"},{type:"key",key:"input_next"},{type:"key",key:"input_previous"}]);
        compare(bridge.closes,0); compare(host.opened,true);
        config.POWER.pressed(); compare(bridge.commands[5],{type:"power"});
        config.POWER.pressed_repeat(); compare(bridge.commands.length,6);
        findChild(host,"airMousePage").back(); compare(bridge.closes,1);
    }
    function test_lg_channel_rocker_opens_picker_and_hdmi1_without_repeats() {
        bridge.busy=false;
        bridge.snapshot=({theme:"black",target_profile:"lg-tv",pointer:false,ready:true,targets:[]});
        navigation.defaultConfig.CHANNEL_UP.pressed();
        navigation.defaultConfig.CHANNEL_UP.pressed_repeat();
        navigation.defaultConfig.CHANNEL_DOWN.pressed();
        navigation.defaultConfig.CHANNEL_DOWN.pressed_repeat();
        compare(bridge.commands,[{type:"key",key:"input_picker"},{type:"key",key:"hdmi1"}]);
    }
    function test_navigation_loss_releases_before_off() {
        navigation.defaultConfig.DPAD_MIDDLE.pressed();
        inputController.activeItem=null;
        wait(1);
        compare(bridge.commands[1],{type:"button",button:1,down:false});
        compare(bridge.commands[2],{type:"off"});
        navigation.defaultConfig.DPAD_MIDDLE.released(); compare(bridge.commands.length,3);
    }
    function test_sleep_keeps_pointing_app_open_and_releases_buttons() {
        navigation.defaultConfig.DPAD_MIDDLE.pressed();
        power.powerModeChanged(0,1);
        compare(bridge.commands[1],{type:"button",button:1,down:false});
        compare(bridge.closes,0); compare(host.opened,true);
        power.powerModeChanged(1,0); compare(host.opened,true);
    }
    function test_low_power_and_suspend_pause_pointing_and_keep_app_open() {
        var modes=[2,3];
        for(var i=0;i<modes.length;i++){
            bridge.commands=[]; navigation.defaultConfig.DPAD_MIDDLE.pressed();
            power.powerModeChanged(0,modes[i]);
            compare(bridge.commands[1],{type:"button",button:1,down:false});
            compare(bridge.commands[2],{type:"off",reason:"Paused for standby"});
            compare(bridge.closes,0); compare(host.opened,true);
            power.powerModeChanged(modes[i],0);
        }
    }
    function test_owned_bluetooth_keeps_pointing_and_rest_intent_with_screen_off() {
        bridge.snapshot=({theme:"black",pointer:true,pointer_enabled:true,bluetooth_backend:"owned",ready:true,targets:[]});
        power.powerModeChanged(0,1);
        power.powerModeChanged(1,2);
        compare(host.pointerSuspended,false); compare(bridge.commands.length,0);
        compare(host.opened,true);
        bridge.snapshot=({theme:"black",pointer:false,pointer_enabled:true,resting:true,bluetooth_backend:"owned",ready:true,targets:[]});
        power.powerModeChanged(2,3);
        compare(host.pointerSuspended,true);
        compare(bridge.commands[0],{type:"off",reason:"Paused for standby"});
        compare(host.opened,true);
    }
    function test_multi_step_sleep_keeps_app_open_after_standby_pause() {
        navigation.defaultConfig.DPAD_MIDDLE.pressed(); bridge.commands=[];
        power.powerModeChanged(0,1); compare(bridge.closes,0);
        power.powerModeChanged(1,2);
        compare(bridge.commands[bridge.commands.length-1],{type:"off",reason:"Paused for standby"});
        bridge.snapshot=({theme:"black",pointer:false,pointer_enabled:false,button_edges:true,ready:true,core_connected:true,targets:[]});
        var sent=bridge.commands.length;
        power.powerModeChanged(2,3);
        compare(bridge.closes,0); compare(host.opened,true); compare(bridge.commands.length,sent);
        inputController.activeItem=null; host.handleFocusLoss(); compare(bridge.commands.length,sent);
        inputController.activeItem=host;
        power.powerModeChanged(3,0); compare(host.keepOpenWhileSleeping,false);
        bridge.snapshot=({theme:"black",pointer:false,ready:false,targets:[]});
        power.powerModeChanged(0,2); compare(bridge.closes,1);
    }
    function test_display_off_never_closes_a_paused_app() {
        bridge.snapshot=({theme:"black",pointer:false,pointer_enabled:false,ready:true,core_connected:true,targets:[]});
        power.powerModeChanged(0,1); compare(bridge.closes,0); compare(host.opened,true); compare(bridge.commands.length,0);
        power.powerModeChanged(1,0); compare(host.opened,true);
        power.powerModeChanged(0,1); power.powerModeChanged(1,2); compare(bridge.closes,1);
    }
    function test_standby_closes_paused_app() {
        bridge.snapshot=({theme:"black",pointer:false,ready:false,targets:[]});
        power.powerModeChanged(0,2); compare(bridge.closes,1);
    }
    function test_power_toggles_and_up_no_longer_toggles() {
        navigation.defaultConfig.POWER.pressed();
        compare(bridge.commands,[{type:"off"}]);
        navigation.defaultConfig.DPAD_UP.pressed();
        compare(bridge.commands,[{type:"off"}]);
    }
    function test_media_works_with_pointer_paused() {
        bridge.busy=false; bridge.snapshot=({theme:"black",pointer:false,ready:true,targets:[]});
        var keys=["PLAY","PREV","NEXT","MUTE","VOLUME_UP","VOLUME_DOWN","STOP"];
        var actions=["play_pause","previous","next","mute","volume_up","volume_down","stop"];
        for(var i=0;i<keys.length;i++) navigation.defaultConfig[keys[i]].pressed();
        for(i=0;i<keys.length;i++) compare(bridge.commands[i],{type:"media",key:actions[i]});
    }
    function test_lg_circle_and_menu_open_distinct_settings_without_repeats() {
        bridge.busy=false;
        bridge.snapshot=({theme:"black",pointer:false,ready:true,target_profile:"lg-tv",targets:[]});
        bridge.commands=[];
        navigation.defaultConfig.RECORD.pressed();
        navigation.defaultConfig.RECORD.pressed_repeat();
        navigation.defaultConfig.MENU.pressed();
        navigation.defaultConfig.MENU.pressed_repeat();
        compare(bridge.commands,[{type:"key",key:"quick_settings"},{type:"key",key:"all_settings"}]);
        bridge.snapshot=({theme:"black",pointer:false,ready:true,target_profile:"computer",targets:[]});
        bridge.commands=[];
        navigation.defaultConfig.RECORD.pressed();
        navigation.defaultConfig.MENU.pressed();
        compare(bridge.commands,[]);
    }
    function test_sleep_focus_loss_does_not_stop_pointing() {
        inputController.activeItem=null;
        power.powerModeChanged(0,1); wait(1);
        compare(bridge.commands.length,0); compare(host.opened,true);
        inputController.activeItem=host; power.powerModeChanged(1,0);
    }
}
