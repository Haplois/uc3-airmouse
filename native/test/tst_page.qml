import QtQuick 2.15
import QtTest 1.2
import "../qml"
TestCase {
    id: test
    name: "DockPage"
    width: 480; height: 800; visible: true
    when: windowShown
    QtObject {
        id: bridge
        property var snapshot: ({theme:"black",pointer:false,ready:true,core_connected:true,target:"a",target_name:"Desktop",targets:[{id:"a",name:"Desktop",ready:true},{id:"b",name:"Living room PC",ready:true},{id:"c",name:"Work laptop",ready:false}],speed:60,output_rate:500,sampling_policy:{requested:1600,satisfied:false},applied_sampling:null})
        property bool connected: true
        property bool busy: false
        property var commands: []
        signal failed(string message)
        signal commandSucceeded(string type)
        function command(value) { commands.push(value); }
    }
    AirMousePage { id: page; bridge: bridge; batteryLevel: 82 }
    function update(values) {
        var state = JSON.parse(JSON.stringify(bridge.snapshot));
        for (var key in values) state[key] = values[key];
        bridge.snapshot = state;
    }
    function init() { bridge.connected=true; bridge.busy=false; page.releaseButtons(); update({swap_click_buttons:false,core_connected:true,bluetooth_ownership:"always",ownership_status:"",target:"a",button_edges:true,bluetooth_backend:"owned",paired:true,pointer:false,pointer_enabled:false,switching:false,ready:true,theme:"black",output_rate:500,stop_reason:"Pointer off",calibrating:false,error:""}); bridge.commands=[]; page.screenPage="mouse"; wait(20); }
    function test_lg_navigation_while_paused() {
        update({target_profile:"lg-tv"});
        try {
            page.remoteHome(); page.remoteBack(); page.buttonPressed(1); page.buttonReleased(1);
            compare(bridge.commands, [{type:"key",key:"home"},{type:"key",key:"back"},{type:"key",key:"ok"}]);
            page.buttonPressed(2, true); page.buttonReleased(2, true);
            compare(bridge.commands[3], {type:"key",key:"back"});
        } finally { update({target_profile:""}); }
    }
    function test_lg_footer_has_app_and_steam_shortcuts_instead_of_back_and_ok() {
        update({target_profile:"lg-tv",pointer:true});
        try {
            wait(20);
            compare(findChild(page,"leftClickButton"),null);
            compare(findChild(page,"rightClickButton"),null);
            var names=["netflix","youtube","steam_machine"];
            for (var i=0;i<names.length;i++) {
                var shortcut=findChild(page,names[i]+"Shortcut");
                verify(shortcut!==null); verify(shortcut.enabled);
                compare(shortcut.text, "");
                compare(shortcut.focusPolicy, Qt.NoFocus);
                var logo=findChild(shortcut,names[i]+"Logo");
                verify(logo!==null);
                tryCompare(logo,"status",Image.Ready);
                shortcut.forceActiveFocus();
                compare(shortcut.background.border.width,0);
                mouseClick(shortcut);
            }
            compare(findChild(page,"steam_machineLogo").source.toString().split("/").pop(),"steam_machine.svg");
            compare(bridge.commands,[{type:"key",key:"netflix"},{type:"key",key:"youtube"},{type:"key",key:"steam_machine"}]);
            grabImage(page).save("/tmp/native-lg-shortcuts.png");
            update({ready:false});
            verify(!findChild(page,"netflixShortcut").enabled);
        } finally { update({target_profile:""}); }
    }
    function test_lg_command_pending_does_not_change_rendered_page() {
        update({target_profile:"lg-tv",pointer:true});
        try {
            var logo=findChild(page,"netflixLogo");
            tryCompare(logo,"status",Image.Ready);
            wait(20);
            var before=grabImage(page);
            bridge.busy=true;
            wait(20);
            var pending=grabImage(page);
            verify(before.equals(pending),"A pending TV command changed visible pixels");
        } finally {
            bridge.busy=false;
            update({target_profile:""});
        }
    }
    function test_lg_pointer_starts_on_connect_and_return_from_settings() {
        update({target_profile:"lg-tv",ready:false});
        wait(150); compare(bridge.commands.length,0);
        update({ready:true}); wait(150);
        compare(bridge.commands,[{type:"on"}]);
        update({pointer:true}); page.toggle();
        compare(bridge.commands.length,1);
        page.navigate("settings"); update({pointer:false}); bridge.commands=[];
        wait(150); compare(bridge.commands.length,0);
        page.navigate("mouse"); wait(150);
        compare(bridge.commands,[{type:"on"}]);
        update({target_profile:""});
    }
    function test_physical_input_while_disconnected_requests_reconnect() {
        update({ready:false});
        page.buttonPressed(1); page.buttonReleased(1);
        compare(bridge.commands,[{type:"reconnect"}]);
        verify(page.notice.indexOf("Reconnecting to Desktop")===0);
        page.toggle(); page.media("mute"); page.direction("up");
        compare(bridge.commands.length,4);
        for (var i=0;i<4;i++) compare(bridge.commands[i].type,"reconnect");
        compare(page.statusText(),"Not connected · press a key or shake to reconnect");
        update({reconnecting:true}); compare(page.statusText(),"Reconnecting · press any key or shake to retry");
        bridge.commands=[]; update({ready:true,reconnecting:false});
        page.direction("up"); compare(bridge.commands,[{type:"key",key:"up"}]);
        bridge.commands=[]; update({ready:false,pairing:true});
        page.buttonPressed(2); page.buttonReleased(2); compare(bridge.commands.length,0);
        update({pairing:false});
    }
    function test_lg_physical_input_while_disconnected_reconnects_but_power_wakes() {
        update({target_profile:"lg-tv",ready:false});
        page.remoteHome(); page.remoteBack(); page.buttonPressed(1); page.buttonReleased(1);
        for (var i=0;i<3;i++) compare(bridge.commands[i].type,"reconnect");
        page.remotePower(); compare(bridge.commands[3],{type:"power"});
        compare(page.statusText(),"TV not connected · press a key or shake, Power turns it on");
        update({target_profile:""});
    }
    function test_lg_power_works_when_tv_is_disconnected() {
        update({target_profile:"lg-tv",ready:false});
        page.remotePower(); compare(bridge.commands,[{type:"power"}]);
        bridge.commands=[]; update({ready:true,pointer:true});
        page.remotePower(); compare(bridge.commands,[{type:"power"}]);
        update({target_profile:""});
    }
    function test_lg_pointer_respects_suspended_session_and_errors() {
        update({target_profile:"lg-tv"}); page.pointerSessionActive=false;
        wait(150); compare(bridge.commands.length,0);
        page.pointerSessionActive=true; update({error:"Sensor unavailable"});
        wait(150); compare(bridge.commands.length,0);
        update({error:""}); wait(150); compare(bridge.commands,[{type:"on"}]);
        update({target_profile:""});
    }
    function test_lg_pointer_click_and_back() {
        update({target_profile:"lg-tv",pointer:true});
        try {
            page.buttonPressed(1); page.buttonReleased(1);
            page.buttonPressed(2); page.buttonReleased(2);
            compare(bridge.commands, [{type:"button",button:1,down:true},{type:"button",button:1,down:false},{type:"key",key:"back"}]);
            bridge.commands=[]; page.navigate("settings"); update({pointer:false}); bridge.commands=[];
            page.remoteBack(); compare(page.screenPage,"mouse"); compare(bridge.commands.length,0);
            bridge.busy=true; page.remoteHome(); compare(bridge.commands.length,0);
        } finally { update({target_profile:""}); }
    }
    function test_button_edges_during_busy() {
        update({pointer:true}); bridge.busy=true;
        page.buttonPressed(1); page.buttonPressed(1); page.buttonPressed(2);
        page.buttonReleased(1); page.buttonReleased(2); page.buttonReleased(2);
        compare(bridge.commands, [
            {type:"button",button:1,down:true}, {type:"button",button:2,down:true},
            {type:"button",button:1,down:false}, {type:"button",button:2,down:false}
        ]);
    }
    function test_buttons_release_on_stop_and_navigation() {
        update({pointer:true}); page.buttonPressed(1); bridge.busy=true;
        update({pointer:false}); page.buttonReleased(1);
        compare(bridge.commands.length,2); compare(bridge.commands[1].down,false);
        compare(page.heldButtons,0); compare(page.physicalButtons,0);
        update({pointer:true}); page.buttonPressed(2); page.navigate("settings");
        compare(bridge.commands[3],{type:"button",button:2,down:false});
        compare(bridge.commands[4].type,"off");
        page.buttonReleased(2); compare(bridge.commands.length,5);
    }
    function test_buttons_clear_on_disconnect() {
        update({pointer:true}); page.buttonPressed(1); bridge.connected=false;
        compare(page.heldButtons,0); compare(page.physicalButtons,0);
        page.buttonReleased(1); compare(bridge.commands.length,1);
        bridge.connected=true; page.buttonPressed(1); page.buttonReleased(1);
        compare(bridge.commands.length,3); compare(bridge.commands[2].down,false);
    }
    function test_stock_buttons_are_single_clicks() {
        update({pointer:true,button_edges:false,bluetooth_backend:"core"});
        page.buttonPressed(1); page.buttonPressed(1); page.buttonReleased(1);
        page.buttonPressed(2); page.buttonReleased(2);
        compare(bridge.commands,[{type:"click",button:1},{type:"click",button:2}]);
        compare(page.heldButtons,0);
    }
    function test_pair_computer() {
        update({paired:false}); wait(20);
        var button=findChild(page,"allDevicesButton");
        compare(button.text,"Pair computer"); mouseClick(button);
        compare(bridge.commands,[{type:"pair"}]);
        update({paired:true}); compare(button.text,"All devices ›");
        update({paired:false,bluetooth_backend:"core"}); compare(button.text,"All devices ›");
    }
    function test_main() {
        verify(findChild(page,"monitorButton"));
        verify(findChild(page,"allDevicesButton").height>=48);
        mouseClick(findChild(page,"monitorButton"));
        compare(bridge.commands[0].type,"on");
        mouseClick(findChild(page,"quickTarget1"));
        compare(bridge.commands[1].target,"b");
    }
    function test_quick_switch_intent_and_cancel() {
        update({pointer:true,pointer_enabled:true});
        mouseClick(findChild(page,"quickTarget1"));
        compare(bridge.commands[0],{type:"target",target:"b",keep_pointer:true});
        update({pointer:false,pointer_enabled:true,switching:true,ready:false});
        bridge.busy=true;
        compare(findChild(page,"monitorButton").Accessible.name,"Pause pointing");
        verify(findChild(page,"monitorButton").enabled);
        page.toggle();compare(bridge.commands[1].type,"off");
        page.navigate("settings");compare(bridge.commands[2].type,"off");
    }
    function test_quick_tile_contents_centered() {
        var button=findChild(page,"quickTarget1"), contents=findChild(button,"quickTargetContents");
        verify(contents);
        var center=contents.mapToItem(button,contents.width/2,contents.height/2);
        verify(Math.abs(center.x-button.width/2)<0.5);
        verify(Math.abs(center.y-button.height/2)<=0.5,"Contents y offset: "+(center.y-button.height/2));
    }
    function test_active_profile_disconnects_after_releasing_input() {
        update({pointer:true,pointer_enabled:true});
        page.buttonPressed(1); page.beginScroll();
        mouseClick(findChild(page,"quickTarget0"));
        compare(bridge.commands,[{type:"button",button:1,down:true},{type:"button",button:1,down:false},{type:"disconnect"}]);
        compare(page.touching,false); compare(page.heldButtons,0);
        update({pointer:false,pointer_enabled:false,target:"",ready:false});
        mouseClick(findChild(page,"quickTarget0"));
        compare(bridge.commands[3],{type:"target",target:"a",keep_pointer:true});
    }
    function test_bottom_click_buttons() {
        verify(!findChild(page,"pointerButton"));
        update({pointer:true});
        var left=findChild(page,"leftClickButton"), right=findChild(page,"rightClickButton");
        for (var button of [left,right]) {
            var position=button.mapToItem(page,0,0);
            compare(button.height,120);
            compare(position.y+button.height,page.height);
            verify(position.x>=0 && position.x+button.width<=page.width);
        }
        mousePress(left); update({}); wait(20);
        compare(findChild(page,"leftClickButton"),left); compare(page.heldButtons,1);
        page.buttonPressed(1); mouseRelease(left);
        compare(bridge.commands,[{type:"button",button:1,down:true}]);
        page.buttonReleased(1);
        compare(bridge.commands[1],{type:"button",button:1,down:false});
        mouseClick(right);
        compare(bridge.commands.slice(2),[{type:"button",button:2,down:true},{type:"button",button:2,down:false}]);
        mousePress(right); mouseMove(right,-20,-20); mouseRelease(right,-20,-20);
        compare(page.heldButtons,0); compare(page.touchButtons,0);
        update({pointer:false}); verify(!left.enabled); verify(!right.enabled);
    }
    function test_swap_click_button_order() {
        page.navigate("settings"); wait(20);
        var normal=findChild(page,"buttonOrderNormal"), swapped=findChild(page,"buttonOrderSwapped");
        verify(normal.primary); verify(!swapped.primary);
        mouseClick(swapped);
        compare(bridge.commands,[{type:"swap_click_buttons",swapped:true}]);
        verify(normal.primary);
        update({swap_click_buttons:true}); verify(swapped.primary);
        bridge.busy=true; verify(!normal.enabled); bridge.busy=false;
        page.navigate("mouse"); wait(20); update({pointer:true});
        var left=findChild(page,"leftClickButton"), right=findChild(page,"rightClickButton");
        verify(right.x<left.x); compare(right.text,"Right click"); compare(left.text,"Left click");
        mouseClick(right); mouseClick(left);
        compare(bridge.commands.slice(1),[
            {type:"button",button:2,down:true},{type:"button",button:2,down:false},
            {type:"button",button:1,down:true},{type:"button",button:1,down:false}
        ]);
        update({pointer:false}); page.navigate("settings"); wait(20);
        mouseClick(findChild(page,"buttonOrderNormal"));
        compare(bridge.commands[5],{type:"swap_click_buttons",swapped:false});
        update({swap_click_buttons:false}); page.navigate("mouse"); wait(20);
        verify(findChild(page,"leftClickButton").x<findChild(page,"rightClickButton").x);
    }
    function test_monitor_toggles_and_respects_readiness() {
        var monitor=findChild(page,"monitorButton");
        mouseClick(monitor); compare(bridge.commands[0],{type:"on"});
        update({pointer:true,pointer_enabled:true});
        page.buttonPressed(1); mouseClick(monitor);
        compare(bridge.commands.slice(1),[{type:"button",button:1,down:true},{type:"button",button:1,down:false},{type:"off"}]);
        update({pointer:false,pointer_enabled:false,ready:false}); verify(!monitor.enabled);
        update({ready:true}); bridge.connected=false; verify(!monitor.enabled);
    }
    function test_settings() {
        mouseClick(findChild(page,"settingsButton")); wait(20);
        compare(page.screenPage,"settings");
        compare(findChild(page,"outputSlider").to,1000);
        page.navigate("colors");wait(20);
        for (var i=0;i<6;i++) verify(findChild(page,"theme_"+["violet","glacier","mint","amber","graphite","black"][i]));
        mouseClick(findChild(page,"theme_mint"));compare(bridge.commands[0].theme,"mint");
        page.back();compare(page.screenPage,"settings");
    }
    function test_bluetooth_ownership_setting() {
        update({bluetooth_ownership:"always",ownership_status:""});
        page.navigate("settings"); wait(20);
        var always=findChild(page,"ownership_always"), session=findChild(page,"ownership_session"), never=findChild(page,"ownership_never");
        verify(always && session && never); verify(always.primary); verify(!session.primary);
        always.clicked(); compare(bridge.commands.length,0);
        session.clicked(); compare(bridge.commands[0],{type:"bluetooth_ownership",mode:"session"});
        update({bluetooth_ownership:"session"}); wait(10); verify(session.primary); verify(!always.primary);
        update({pointer:true}); wait(10); verify(!never.enabled);
        update({pointer:false,core_connected:false,ownership_status:"Taking over Bluetooth"}); wait(10);
        compare(page.statusText(),"Taking over Bluetooth");
    }
    function test_geometry() {
        for (var name of ["mouse","settings","colors","targets","calibrate"]) {
            page.screenPage=name;wait(50);
            grabImage(page).save("/tmp/native-"+name+".png");
        }
    }
    function test_theme_bounds() {
        page.navigate("colors");wait(20);
        for (var name of ["violet","glacier","mint","amber","graphite","black"]) {
            var button=findChild(page,"theme_"+name);
            var position=button.mapToItem(page,0,0);
            verify(position.x>=0 && position.x+button.width<=page.width);
            verify(position.y>=0 && position.y+button.height<=page.height);
            update({theme:name});wait(10);
            compare(page.palette.name,button.choice.name);
        }
        compare(page.color,"#000000");compare(page.palette.card,"#000000");
    }
    function test_output_slider() {
        page.navigate("settings");wait(20);
        var slider=findChild(page,"outputSlider");
        slider.forceActiveFocus();keyClick(Qt.Key_Right);
        compare(bridge.commands.length,1);compare(bridge.commands[0].rate,510);
        bridge.commands=[];
        mousePress(slider,slider.width*0.7,slider.height/2);
        mouseMove(slider,slider.width*0.9,slider.height/2);
        compare(bridge.commands.length,0);
        var dragged=slider.value;update({});wait(20);compare(slider.value,dragged);
        mouseRelease(slider,slider.width*0.9,slider.height/2);
        compare(bridge.commands.length,1);verify(bridge.commands[0].rate>=850);
    }
    function test_scroll_release_and_disconnect() {
        update({pointer:true});page.beginScroll();page.scroll(0.2);wait(40);
        verify(bridge.commands.length>0);compare(bridge.commands[0].type,"scroll");compare(bridge.commands[0].direction,1);
        page.endScroll();var count=bridge.commands.length;wait(80);compare(bridge.commands.length,count);
        page.beginScroll();page.scroll(-0.2);bridge.connected=false;wait(80);
        compare(page.touching,false);compare(page.wheelFraction,0);compare(bridge.commands.length,count);
    }
    function test_reconnect_keeps_tv_context_and_reports_prolonged_failure() {
        update({target:"a",target_name:"LG TV",target_profile:"lg-tv",pointer:false,pointer_enabled:false,ready:false,core_connected:false});
        bridge.connected=false;
        compare(page.statusText(),"Reconnecting…");
        verify(page.lgTV);
        verify(!findChild(page,"monitorButton").enabled);
        page.remoteBack(); page.remoteHome(); page.direction("up");
        compare(bridge.commands.length,0);
        compare(page.screenPage,"mouse");
        tryCompare(page,"reconnectExpired",true,5500);
        compare(page.statusText(),"Air mouse service unavailable");
        bridge.connected=true;
        compare(page.statusText(),"Bluetooth service unavailable");
        verify(!findChild(page,"allDevicesButton").enabled);
        verify(!findChild(page,"quickTarget0").enabled);
        update({core_connected:true,ready:true});
        verify(!page.reconnecting);
        verify(!page.reconnectExpired);
        tryCompare(page,"automaticStartRequested",true);
        compare(bridge.commands,[{type:"on"}]);
        update({target_profile:"computer"});
    }
    function test_initial_connection_does_not_claim_no_pairings() {
        var previous = bridge.snapshot;
        bridge.snapshot=({theme:"black",targets:[],target:"",target_name:"",core_connected:false});
        bridge.connected=false;
        compare(findChild(page,"targetName").text,"Connecting…");
        compare(findChild(page,"emptyTargets").text,"Loading devices…");
        bridge.connected=true;
        compare(findChild(page,"targetName").text,"Connecting…");
        update({core_connected:true});
        compare(findChild(page,"targetName").text,"Choose a computer");
        verify(findChild(page,"emptyTargets").text.indexOf("No paired")===0);
        bridge.snapshot=previous;
    }
    function test_settings_pause() {
        update({pointer:true});page.navigate("settings");
        compare(bridge.commands[0].type,"off");compare(bridge.commands[0].reason,"Paused for Settings");
    }
    function test_calibration_revisit() {
        update({stop_reason:"Calibration complete"});
        page.navigate("calibrate");
        compare(bridge.commands[0].type,"off");
        compare(bridge.commands[0].reason,"Paused for calibration");
        update({stop_reason:bridge.commands[0].reason});wait(20);
        compare(findChild(page,"startCalibrationButton").text,"Start calibration");
        mouseClick(findChild(page,"startCalibrationButton"));
        compare(bridge.commands[1].type,"calibrate");
    }
}
