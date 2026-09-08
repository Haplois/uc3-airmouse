#include "../cpp/AirMouseBridge.h"
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalServer>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QtTest>
#include <memory>

class BridgeTest : public QObject {
    Q_OBJECT
private:
    QTemporaryDir directory;
    QLocalServer server;
    QLocalSocket *peer = nullptr;
    std::unique_ptr<AirMouseBridge> bridge;
    QList<QVariantMap> requests;
    QByteArray buffer;
    void reply(const QVariantMap &value) {
        peer->write(QJsonDocument::fromVariant(value).toJson(QJsonDocument::Compact) + '\n');
        peer->flush();
    }
private slots:
    void init() {
        requests.clear(); buffer.clear();
        const auto path = directory.filePath("control.sock");
        qputenv("AIRMOUSE_UI_SOCKET", path.toUtf8());
        QVERIFY(server.listen(path));
        bridge = std::make_unique<AirMouseBridge>();
        bridge->open();
        QTRY_VERIFY(server.hasPendingConnections());
        peer = server.nextPendingConnection();
        connect(peer, &QLocalSocket::readyRead, this, [this] {
            buffer += peer->readAll();
            int end;
            while ((end = buffer.indexOf('\n')) >= 0) {
                const auto request = QJsonDocument::fromJson(buffer.left(end)).object().toVariantMap();
                buffer.remove(0, end + 1);
                if (request.value("type") != "ping") requests.append(request);
            }
        });
        reply({{"version",1},{"state",QVariantMap{{"pointer",true},{"button_edges",true}}}});
        QTRY_VERIFY(bridge->connected());
    }
    void cleanup() {
        bridge.reset(); delete peer; peer = nullptr; server.close();
    }
    void edgesWhileBusy() {
        bridge->command({{"type","scroll"},{"direction",1}});
        QVERIFY(bridge->busy());
        bridge->command({{"type","button"},{"button",1},{"down",true}});
        bridge->command({{"type","button"},{"button",2},{"down",true}});
        bridge->command({{"type","button"},{"button",1},{"down",false}});
        bridge->command({{"type","button"},{"button",2},{"down",false}});
        QTRY_COMPARE(requests.size(),5);
        QCOMPARE(requests[1].value("down").toBool(),true);
        QCOMPARE(requests[3].value("down").toBool(),false);
        for (const auto &request : requests) reply({{"id",request.value("id")},{"ok",true}});
        QTRY_VERIFY(!bridge->busy());
    }
    void stopPreemptsAtCapacity() {
        for (int i = 0; i < 32; ++i) bridge->command({{"type","button"},{"button",1},{"down",bool(i % 2)}});
        bridge->command({{"type","off"}});
        bridge->command({{"type","button"},{"button",1},{"down",false}});
        QTRY_COMPARE(requests.size(),34);
        QVERIFY(bridge->connected());
        QCOMPARE(requests[32].value("type").toString(),QString("off"));
        reply({{"id",requests[32].value("id")},{"ok",true}});
        reply({{"id",requests[33].value("id")},{"ok",true}});
        QTRY_VERIFY(!bridge->busy());
    }
    void overflowDisconnects() {
        QSignalSpy failures(bridge.get(), &AirMouseBridge::failed);
        for (int i = 0; i < 33; ++i) bridge->command({{"type","button"},{"button",1},{"down",bool(i % 2)}});
        QTRY_VERIFY(!bridge->connected());
        QTRY_COMPARE(peer->state(),QLocalSocket::UnconnectedState);
        QVERIFY(!bridge->busy()); QVERIFY(!failures.isEmpty());
    }
    void releaseAfterPointerStops() {
        bridge->command({{"type","button"},{"button",1},{"down",true}});
        reply({{"version",1},{"state",QVariantMap{{"pointer",false},{"button_edges",true}}}});
        QTRY_VERIFY(!bridge->snapshot().value("pointer").toBool());
        QVERIFY(bridge->busy());
        bridge->command({{"type","button"},{"button",1},{"down",false}});
        QTRY_COMPARE(requests.size(),2);
        QCOMPARE(requests[1].value("down").toBool(),false);
    }
    void destructionDisconnects() {
        bridge->command({{"type","button"},{"button",1},{"down",true}});
        QTRY_COMPARE(requests.size(),1);
        bridge.reset();
        QTRY_COMPARE(peer->state(),QLocalSocket::UnconnectedState);
    }
    void invalidEdgesAreRejected() {
        QSignalSpy failures(bridge.get(), &AirMouseBridge::failed);
        bridge->command({{"type","button"},{"button",3},{"down",true}});
        bridge->command({{"type","button"},{"button",1},{"down",1}});
        bridge->command({{"type","button"},{"button","1"},{"down",true}});
        bridge->command({{"type","button"},{"button",1.5},{"down",true}});
        QCOMPARE(failures.size(),4); QVERIFY(!bridge->busy());
        bridge->command({{"type","button"},{"button",1.0},{"down",false}});
        QTRY_COMPARE(requests.size(),1);
    }
    void metadataSuccessIsAcknowledged() {
        QSignalSpy successes(bridge.get(), &AirMouseBridge::commandSucceeded);
        bridge->command({{"type","rename"},{"target","00000001"},{"name","Desk"}});
        QTRY_COMPARE(requests.size(),1); QCOMPARE(successes.size(),0);
        reply({{"id",requests[0].value("id")},{"ok",true}});
        QTRY_COMPARE(successes.size(),1);
        QCOMPARE(successes[0][0].toString(),QString("rename"));
        QVERIFY(!bridge->busy());
    }
    void metadataFailureDoesNotEmitSuccess() {
        QSignalSpy successes(bridge.get(), &AirMouseBridge::commandSucceeded);
        QSignalSpy failures(bridge.get(), &AirMouseBridge::failed);
        bridge->command({{"type","forget"},{"target","00000001"}});
        QTRY_COMPARE(requests.size(),1);
        reply({{"id",requests[0].value("id")},{"ok",false},{"error","Storage unavailable"}});
        QTRY_COMPARE(failures.size(),1); QCOMPARE(successes.size(),0);
        QVERIFY(!bridge->busy());
    }
    void offIgnoresPreemptedMetadataReplies() {
        QSignalSpy successes(bridge.get(), &AirMouseBridge::commandSucceeded);
        QSignalSpy failures(bridge.get(), &AirMouseBridge::failed);
        bridge->command({{"type","rename"},{"target","00000001"},{"name","Desk"}});
        bridge->command({{"type","off"}});
        QTRY_COMPARE(requests.size(),2);
        reply({{"id",requests[0].value("id")},{"ok",true}});
        reply({{"id",requests[0].value("id")},{"ok",false},{"error","Superseded"}});
        reply({{"id",requests[1].value("id")},{"ok",true}});
        QTRY_VERIFY(!bridge->busy());
        QCOMPARE(successes.size(),1); QCOMPARE(successes[0][0].toString(),QString("off"));
        QCOMPARE(failures.size(),0);
    }
    void ordinaryCommandsStaySerialized() {
        QSignalSpy failures(bridge.get(), &AirMouseBridge::failed);
        bridge->command({{"type","on"}});
        bridge->command({{"type","pair"}});
        QTRY_COMPARE(requests.size(),1); QCOMPARE(failures.size(),1);
        bridge->close();
        QTRY_COMPARE(peer->state(),QLocalSocket::UnconnectedState);
    }
};
QTEST_GUILESS_MAIN(BridgeTest)
#include "tst_bridge.moc"
