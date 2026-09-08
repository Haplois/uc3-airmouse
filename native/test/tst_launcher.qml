import QtQuick 2.15
import QtTest 1.2
import "../qml/Launcher.js" as Launcher
TestCase {
    name: "NativeLauncher"
    function test_launch_entity() {
        var launches=[];
        function open(source) { launches.push(source); }
        verify(!Launcher.launch("other.launch", "airmouse.main.launch", false, open));
        verify(!Launcher.launch("", "", false, open));
        verify(Launcher.launch("airmouse.main.launch", "airmouse.main.launch", false, open));
        compare(launches.length,1); compare(launches[0],"qrc:/airmouse/AirMouseHost.qml");
        verify(Launcher.launch("airmouse.main.launch", "airmouse.main.launch", true, open));
        compare(launches.length,1);
    }
}
