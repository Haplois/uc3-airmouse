import QtQuick 2.15
import QtQuick.Window 2.15
Window {
    id: window
    width: 480; height: 800; visible: true
    title: "Air mouse native preview"
    AirMousePage { id: page; anchors.fill: parent; bridge: airMouseBridge; onExitRequested: Qt.quit() }
    Component.onCompleted: airMouseBridge.open()
    Timer { interval: 2500; running: previewCapture !== ""; onTriggered: page.grabToImage(function(result) { result.saveToFile(previewCapture + "/native-live.png"); }) }
    Timer { interval: 4000; running: previewCapture !== ""; onTriggered: Qt.quit() }
}
