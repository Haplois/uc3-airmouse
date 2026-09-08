// SPDX-License-Identifier: GPL-3.0-or-later
// Called from the patched Remote UI main.qml; derivative of that GPL-3.0-or-later program.
.pragma library

function launch(entityId, expectedId, alreadyOpen, open) {
    if (!expectedId || entityId !== expectedId) return false;
    if (!alreadyOpen) open("qrc:/airmouse/AirMouseHost.qml");
    return true;
}
