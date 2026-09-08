import QtQuick 2.15
import QtQuick.Controls 2.15
Button {
    id: control
    property var tones
    property bool primary: false
    property string glyph: ""
    property int textSize: 18
    property real cornerRadius: 15
    implicitHeight: 52
    font.pixelSize: textSize
    opacity: enabled ? 1 : 0.45
    background: Rectangle { radius: control.cornerRadius; color: control.primary ? control.tones.accent : control.tones.card; border.color: control.activeFocus ? control.tones.accent : control.tones.line; border.width: control.activeFocus ? 2 : 1; opacity: control.down ? 0.7 : 1 }
    contentItem: Item {
        implicitWidth: contents.implicitWidth
        implicitHeight: contents.implicitHeight
        Row {
            id: contents
            anchors.centerIn: parent
            spacing: control.glyph && control.text ? 10 : 0
            Glyph { visible: control.glyph !== ""; kind: control.glyph; width: 24; height: 24; anchors.verticalCenter: parent.verticalCenter; ink: control.primary ? control.tones.ink : control.tones.fg }
            Text { visible: control.text !== ""; textFormat: Text.PlainText; text: control.text; font: control.font; color: control.primary ? control.tones.ink : control.tones.fg; anchors.verticalCenter: parent.verticalCenter }
        }
    }
}
