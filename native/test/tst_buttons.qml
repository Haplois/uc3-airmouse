import QtQuick 2.15
import QtTest 1.2
import "../qml"
import "../qml/Palette.js" as Palettes
TestCase {
    name: "ButtonAlignment"
    width: 480; height: 800; visible: true; when: windowShown
    ActionButton { id: button; width: 56; height: 56; glyph: "back"; tones: Palettes.get("black") }
    function canvas(item) {
        if (item.kind !== undefined) return item;
        for (var i=0;i<item.children.length;i++) { var found=canvas(item.children[i]); if(found) return found; }
        return null;
    }
    function test_icon_only_center() {
        var icon=canvas(button.contentItem); verify(icon);
        var center=icon.mapToItem(button,icon.width/2,icon.height/2);
        verify(Math.abs(center.x-button.width/2)<0.5,"Icon x offset: "+(center.x-button.width/2));
        verify(Math.abs(center.y-button.height/2)<0.5,"Icon y offset: "+(center.y-button.height/2));
    }
}
