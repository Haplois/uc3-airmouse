#pragma once

#include <QObject>
#include <QLocalSocket>
#include <QTimer>
#include <QElapsedTimer>
#include <QVariantMap>
#include <QHash>

class AirMouseBridge : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantMap snapshot READ snapshot NOTIFY changed)
    Q_PROPERTY(bool connected READ connected NOTIFY changed)
    Q_PROPERTY(bool busy READ busy NOTIFY changed)
    Q_PROPERTY(QString launchEntityId READ launchEntityId CONSTANT)
public:
    explicit AirMouseBridge(QObject *parent = nullptr);
    ~AirMouseBridge() override;
    QVariantMap snapshot() const { return m_state; }
    bool connected() const { return m_connected; }
    bool busy() const { return !m_pending.isEmpty(); }
    QString launchEntityId() const { return qEnvironmentVariable("AIRMOUSE_LAUNCH_ENTITY_ID", "airmouse.main.launch"); }
    Q_INVOKABLE void open();
    Q_INVOKABLE void close();
    Q_INVOKABLE void command(const QVariantMap &value);
signals:
    void changed();
    void failed(QString message);
    void commandSucceeded(QString type);
private:
    void receive();
    void write(const QVariantMap &value);
    QLocalSocket m_socket;
    QTimer m_timer;
    QElapsedTimer m_received, m_requestAge;
    QVariantMap m_state;
    QByteArray m_buffer;
    QHash<int, QString> m_pending;
    int m_next = 0;
    bool m_open = false, m_connected = false;
};
