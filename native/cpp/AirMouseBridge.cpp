#include "AirMouseBridge.h"
#include <QJsonDocument>
#include <QJsonObject>
#include <QMetaType>

AirMouseBridge::AirMouseBridge(QObject *parent) : QObject(parent) {
    m_timer.setInterval(500);
    connect(&m_socket, &QLocalSocket::readyRead, this, &AirMouseBridge::receive);
    connect(&m_socket, &QLocalSocket::disconnected, this, [this]() {
        m_connected = false; m_pending.clear(); m_buffer.clear(); m_state.clear(); emit changed();
    });
    connect(&m_timer, &QTimer::timeout, this, [this]() {
        if (!m_open) return;
        if (m_socket.state() == QLocalSocket::UnconnectedState) {
            m_socket.connectToServer(qEnvironmentVariable("AIRMOUSE_UI_SOCKET", "/app/airmouse/control.sock"));
            m_received.start();
        } else if (m_socket.state() == QLocalSocket::ConnectedState) {
            if (m_received.elapsed() > 2500 || (busy() && m_requestAge.elapsed() > 5000)) {
                m_socket.abort(); emit failed(tr("Air mouse service stopped responding"));
            } else write({{"type", "ping"}});
        }
    });
}
AirMouseBridge::~AirMouseBridge() { close(); }
void AirMouseBridge::open() { m_open = true; m_timer.start(); m_socket.connectToServer(qEnvironmentVariable("AIRMOUSE_UI_SOCKET", "/app/airmouse/control.sock")); m_received.start(); }
void AirMouseBridge::close() { m_open = false; m_timer.stop(); m_socket.abort(); m_connected = false; m_pending.clear(); m_state.clear(); emit changed(); }
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
    if (busy() && !stop && !edge) { emit failed(tr("Still working on the previous action")); return; }
    if (stop) m_pending.clear();
    if (m_pending.size() >= 32) {
        m_socket.abort(); emit failed(tr("Too many pending mouse button edges")); return;
    }
    QVariantMap request(value); request["id"] = ++m_next;
    if (m_pending.isEmpty()) m_requestAge.start();
    m_pending.insert(m_next, type); write(request); emit changed();
}
void AirMouseBridge::receive() {
    m_buffer += m_socket.readAll();
    if (m_buffer.size() > 131072) { m_socket.abort(); return; }
    int end;
    while ((end = m_buffer.indexOf('\n')) >= 0) {
        QJsonParseError error;
        const auto doc = QJsonDocument::fromJson(m_buffer.left(end), &error); m_buffer.remove(0, end + 1);
        if (error.error != QJsonParseError::NoError || !doc.isObject()) { m_socket.abort(); return; }
        const auto object = doc.object(); m_received.restart();
        if (object.contains("state") && object.value("version").toInt() == 1) {
            m_state = object.value("state").toObject().toVariantMap(); m_connected = true;
        } else if (object.contains("id")) {
            const auto type = m_pending.take(object.value("id").toInt());
            if (!type.isEmpty()) {
                if (object.value("ok").toBool()) emit commandSucceeded(type);
                else emit failed(object.value("error").toString());
            }
        }
        emit changed();
    }
}
