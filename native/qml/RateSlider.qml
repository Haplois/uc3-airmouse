import QtQuick 2.15
import QtQuick.Controls 2.15
Slider {
    id: slider
    property var tones
    property real settingValue: from
    property bool pending: false
    onSettingValueChanged: if (!pressed) value = settingValue
    onPendingChanged: if (!pending && !pressed) value = settingValue
    Component.onCompleted: value = settingValue
    implicitHeight: 44
    background: Rectangle {
        x: slider.leftPadding; y: slider.topPadding + slider.availableHeight / 2 - height / 2
        width: slider.availableWidth; height: 6; radius: 3; color: slider.tones.line
        Rectangle { width: slider.visualPosition * parent.width; height: parent.height; radius: 3; color: slider.tones.accent }
    }
    handle: Rectangle {
        x: slider.leftPadding + slider.visualPosition * (slider.availableWidth - width)
        y: slider.topPadding + slider.availableHeight / 2 - height / 2
        width: 26; height: 26; radius: 13; color: slider.tones.accent
        border.color: slider.activeFocus ? slider.tones.fg : slider.tones.accent
        border.width: slider.activeFocus ? 2 : 0
    }
}
