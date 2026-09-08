QT += core network testlib
CONFIG += console testcase c++17
CONFIG -= app_bundle
TARGET = tst_bridge
SOURCES += tst_bridge.cpp ../cpp/AirMouseBridge.cpp
HEADERS += ../cpp/AirMouseBridge.h
