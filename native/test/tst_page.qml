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
        signal changed()
        onConnectedChanged: changed()
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
    function init() { bridge.connected=true; bridge.busy=false; page.releaseButtons(); update({button_edges:true,bluetooth_backend:"owned",paired:true,pointer:false,pointer_enabled:false,switching:false,ready:true,theme:"black",output_rate:500,stop_reason:"Pointer off",calibrating:false,error:""}); bridge.commands=[]; page.screenPage="mouse"; wait(20); }
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
        verify(findChild(page,"pointerButton"));
        verify(findChild(page,"allDevicesButton").height>=48);
        mouseClick(findChild(page,"pointerButton"));
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
        compare(findChild(page,"pointerButton").text,"Pause pointing");
        verify(findChild(page,"pointerButton").enabled);
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
