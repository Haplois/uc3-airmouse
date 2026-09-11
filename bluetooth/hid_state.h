#ifndef AIRMOUSE_HID_STATE_H
#define AIRMOUSE_HID_STATE_H
#include <stdbool.h>
#include <stdint.h>
#define HID_QUEUE_SIZE 16

typedef struct {
    uint32_t id, time;
    int32_t dx, dy, wheel;
    uint8_t buttons;
    bool motion;
    int16_t axes[6];
    bool consumer;
    bool keyboard;
    uint16_t usage;
} hid_report;

typedef struct {
    hid_report queue[HID_QUEUE_SIZE];
    unsigned head, count;
    uint8_t buttons;
    bool active;
    uint32_t dropped;
} hid_state;

void hid_reset(hid_state *state);
bool hid_open(hid_state *state);
bool hid_button(hid_state *state, uint32_t id, uint8_t buttons, uint32_t now);
bool hid_move(hid_state *state, int32_t dx, int32_t dy, uint32_t now);
bool hid_scroll(hid_state *state, uint32_t id, int32_t wheel, uint32_t now);
bool hid_media(hid_state *state, uint32_t id, uint16_t usage, uint32_t now);
bool hid_key_supported(uint8_t usage);
bool hid_key(hid_state *state, uint32_t id, uint8_t usage, uint32_t now);
bool hid_imu(hid_state *state, const int16_t axes[6], uint32_t now);
bool hid_remote_key(hid_state *state, uint32_t id, uint16_t key, uint32_t now);
void hid_stop(hid_state *state, uint32_t id, uint32_t now);
const hid_report *hid_peek(hid_state *state, uint32_t now);
void hid_pop(hid_state *state);
void hid_encode(const hid_report *report, uint8_t data[6]);
#endif
