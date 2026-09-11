#include "AirMouseBridge.h"
#include <QJsonDocument>
#include <QJsonObject>
#include <QMetaType>

static QVariantList offlineTargets(const QVariant &value) {
    QVariantList targets;
    for (const auto &item : value.toList()) {
        auto target = item.toMap();
        target["ready"] = false;
        target["connected"] = false;
        targets.append(target);
    }
    return targets;
}

AirMouseBridge::AirMouseBridge(QObject *parent) : QObject(parent) {
    m_timer.setInterval(500);
    connect(&m_socket, &QLocalSocket::readyRead, this, &AirMouseBridge::receive);
    connect(&m_socket, &QLocalSocket::disconnected, this, &AirMouseBridge::resetConnection);
    connect(&m_timer, &QTimer::timeout, this, [this]() {
        if (!m_open) return;
        if (m_socket.state() == QLocalSocket::UnconnectedState) {
            reconnect();
        } else if (m_socket.state() == QLocalSocket::ConnectedState) {
            const int requestTimeout = m_pending.values().contains("pair_lg") ? 30000 : 5000;
            if (m_received.elapsed() > 2500 || (busy() && m_requestAge.elapsed() > requestTimeout)) {
                m_socket.abort(); emit failed(tr("Air mouse service stopped responding"));
            } else write({{"type", "ping"}});
        }
    });
}
AirMouseBridge::~AirMouseBridge() { close(); }

void AirMouseBridge::open() {
    m_open = true;
    m_timer.start();
    reconnect();
}

void AirMouseBridge::reconnect() {
    if (!m_open || m_socket.state() != QLocalSocket::UnconnectedState) return;
    m_socket.connectToServer(qEnvironmentVariable("AIRMOUSE_UI_SOCKET", "/app/airmouse/control.sock"));
    m_received.start();
}
void AirMouseBridge::close() {
    m_open = false;
    m_timer.stop();
    m_socket.abort();
    resetConnection();
}

void AirMouseBridge::resetConnection() {
    const bool wasConnected = m_connected;
    const bool wasBusy = busy();
    const auto previousState = m_state;
    m_connected = false;
    m_pending.clear();
    m_buffer.clear();
    if (m_open) {
        for (const auto key : {"pointer", "pointer_enabled", "ready", "core_connected", "switching", "calibrating"}) m_state[key] = false;
        m_state["targets"] = offlineTargets(m_state.value("targets"));
    } else {
        m_state.clear();
    }
    if (m_state != previousState) emit snapshotChanged();
    if (m_connected != wasConnected) emit connectedChanged();
    if (busy() != wasBusy) emit busyChanged();
}

void AirMouseBridge::write(const QVariantMap &value) {
    if (m_socket.bytesToWrite() > 16384) { m_socket.abort(); return; }
    m_socket.write(QJsonDocument::fromVariant(value).toJson(QJsonDocument::Compact) + '\n');
}
void AirMouseBridge::command(const QVariantMap &value) {
    if (!connected()) { emit failed(tr("Air mouse service unavailable")); return; }
    const auto type = value.value("type").toString();
    const bool edge = type == "button";
    const bool stop = type == "off";
    if (edge) {
        const auto button = value.value("button");
        const auto buttonType = button.userType();
        const bool number = buttonType == QMetaType::Int || buttonType == QMetaType::UInt || buttonType == QMetaType::Double;
        if (!number || (button.toDouble() != 1 && button.toDouble() != 2) || value.value("down").userType() != QMetaType::Bool) {
            emit failed(tr("Invalid mouse button edge")); return;
        }
    }
    if (!stop && !edge) {
        for (const auto &pending : m_pending) {
            if (pending != "button") { emit failed(tr("Still working on the previous action")); return; }
        }
    }
    const bool wasBusy = busy();
    if (stop) m_pending.clear();
    if (m_pending.size() >= 32) {
        m_socket.abort(); emit failed(tr("Too many pending mouse button edges")); return;
    }
    QVariantMap request(value); request["id"] = ++m_next;
    if (m_pending.isEmpty()) m_requestAge.start();
    m_pending.insert(m_next, type); write(request);
    if (busy() != wasBusy) emit busyChanged();
}
void AirMouseBridge::receive() {
    m_buffer += m_socket.readAll();
    if (m_buffer.size() > 131072) { m_socket.abort(); return; }
    int end;
    while ((end = m_buffer.indexOf('\n')) >= 0) {
        QJsonParseError error;
        const auto doc = QJsonDocument::fromJson(m_buffer.left(end), &error);
        m_buffer.remove(0, end + 1);
        if (error.error != QJsonParseError::NoError || !doc.isObject()) { m_socket.abort(); return; }
        const auto object = doc.object();
        m_received.restart();
        bool snapshotNotify = false;
        bool connectedNotify = false;
        if (object.contains("state") && object.value("version").toInt() == 1) {
            auto state = object.value("state").toObject().toVariantMap();
            if (state.contains("core_connected") && !state.value("core_connected").toBool()) {
                for (const auto key : {"target", "target_name", "target_profile", "paired", "device_management", "host_limit"}) {
                    if (m_state.contains(key)) state[key] = m_state.value(key);
                }
                if (m_state.contains("targets")) state["targets"] = offlineTargets(m_state.value("targets"));
            }
            snapshotNotify = state != m_state;
            connectedNotify = !m_connected;
            m_state = state;
            m_connected = true;
        } else if (object.contains("id")) {
            const bool wasBusy = busy();
            const auto type = m_pending.take(object.value("id").toInt());
            if (busy() != wasBusy) emit busyChanged();
            if (!type.isEmpty()) {
                if (object.value("ok").toBool()) emit commandSucceeded(type);
                else emit failed(object.value("error").toString());
            }
        }
        if (snapshotNotify) emit snapshotChanged();
        if (connectedNotify) emit connectedChanged();
    }
}
