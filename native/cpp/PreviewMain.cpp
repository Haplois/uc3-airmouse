#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include "AirMouseBridge.h"

int main(int argc, char **argv) {
    QGuiApplication app(argc, argv);
    QQuickWindow::setTextRenderType(QQuickWindow::NativeTextRendering);
    AirMouseBridge bridge;
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("airMouseBridge", &bridge);
    engine.rootContext()->setContextProperty("previewCapture", qEnvironmentVariable("AIRMOUSE_CAPTURE_DIR"));
    engine.load(QUrl("qrc:/airmouse/Preview.qml"));
    if (engine.rootObjects().isEmpty()) return 1;
    QObject::connect(&app, &QGuiApplication::aboutToQuit, &bridge, &AirMouseBridge::close);
    return app.exec();
}
