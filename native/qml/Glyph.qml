import QtQuick 2.15
Canvas {
    id: glyph
    property string kind: "pointer"
    property string deviceName: ""
    property string bluetoothName: ""
    property color ink: "white"
    readonly property string resolvedKind: kind === "device" ? classifyDevice(bluetoothName, deviceName) : kind
    function classifyDeviceName(name) {
        var value = (name || "").toLowerCase();
        if (/(^|[^a-z])ipad([^a-z]|$)/.test(value)) return "ipad";
        if (/(^|[^a-z])iphone([^a-z]|$)/.test(value)) return "iphone";
        if (/(^|[^a-z])(android|pixel|galaxy|oneplus)([^a-z]|$)/.test(value) || /(^|[^a-z])sm-[a-z0-9]+/.test(value)) return "android";
        if (/(^|[^a-z])(phone|mobile|handset)([^a-z]|$)/.test(value)) return "phone";
        if (/(^|[^a-z])(laptop|notebook|macbook|thinkpad|chromebook)([^a-z]|$)/.test(value) || /surface[ -]?book/.test(value)) return "laptop";
        if (/(^|[^a-z])(desktop|pc|workstation)([^a-z]|$)/.test(value)) return "desktop";
        return "";
    }
    function classifyDevice(bluetooth, display) {
        return classifyDeviceName(bluetooth) || classifyDeviceName(display) || "desktop";
    }
    onKindChanged: requestPaint()
    onResolvedKindChanged: requestPaint()
    onInkChanged: requestPaint()
    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()
    onPaint: {
        var c = getContext("2d"); c.reset(); c.scale(width / 24, height / 24);
        c.strokeStyle = ink; c.lineWidth = 1.6; c.lineCap = "round"; c.lineJoin = "round";
        c.beginPath();
        if (resolvedKind === "pointer") { c.moveTo(5,3); c.lineTo(19,13); c.lineTo(12,14); c.lineTo(8,21); c.closePath(); }
        else if (resolvedKind === "pause") { c.moveTo(8,5); c.lineTo(8,19); c.moveTo(16,5); c.lineTo(16,19); }
        else if (resolvedKind === "back") { c.moveTo(15.5,5); c.lineTo(8.5,12); c.lineTo(15.5,19); }
        else if (resolvedKind === "next") { c.moveTo(8.5,5); c.lineTo(15.5,12); c.lineTo(8.5,19); }
        else if (resolvedKind === "check") { c.moveTo(5,12); c.lineTo(9,16); c.lineTo(19,6); }
        else if (resolvedKind === "desktop") {
            c.rect(1.5,4,14,11); c.moveTo(8.5,15); c.lineTo(8.5,19); c.moveTo(5.5,19); c.lineTo(11.5,19);
            c.rect(18,4,4.5,17); c.moveTo(19.5,7); c.lineTo(21,7);
        }
        else if (resolvedKind === "laptop") {
            c.rect(4,3,16,13); c.moveTo(4,18); c.lineTo(2,20.5); c.lineTo(22,20.5); c.lineTo(20,18); c.closePath();
        }
        else if (resolvedKind === "ipad") {
            c.rect(4,2,16,20); c.rect(5.7,4,12.6,15); c.moveTo(11.5,20.5); c.lineTo(12.5,20.5);
        }
        else if (resolvedKind === "iphone") {
            c.rect(6,1.5,12,21); c.moveTo(10,4); c.lineTo(14,4); c.moveTo(10,20); c.lineTo(14,20);
        }
        else if (resolvedKind === "android") {
            c.rect(5,2,14,20); c.moveTo(9,8); c.lineTo(8,6); c.moveTo(15,8); c.lineTo(16,6);
            c.moveTo(8.5,11); c.arc(12,11,3.5,Math.PI,0); c.lineTo(15.5,16); c.lineTo(8.5,16); c.closePath();
            c.moveTo(10,17.5); c.lineTo(10,19); c.moveTo(14,17.5); c.lineTo(14,19);
        }
        else if (resolvedKind === "phone") {
            c.rect(5,2,14,20); c.moveTo(10,4); c.lineTo(14,4); c.moveTo(12.7,19.5); c.arc(12,19.5,0.7,0,Math.PI*2);
        }
        else if (resolvedKind === "settings") { for (var i=0;i<3;i++) { var y=6+i*6; c.moveTo(4,y); c.lineTo(20,y); var x=i===1?16:8; c.moveTo(x,y-3); c.lineTo(x,y+3); } }
        else { c.arc(12,12,7,0,Math.PI*2); c.moveTo(12,2); c.lineTo(12,6); c.moveTo(12,18); c.lineTo(12,22); c.moveTo(2,12); c.lineTo(6,12); c.moveTo(18,12); c.lineTo(22,12); }
        c.stroke();
    }
}
