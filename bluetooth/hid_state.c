#include "hid_state.h"
#include <string.h>

static int32_t clamp(int64_t value, int32_t limit) {
    return value > limit ? limit : value < -limit ? -limit : (int32_t)value;
}
static hid_report *append(hid_state *state) {
    if (state->count == HID_QUEUE_SIZE) return NULL;
    hid_report *report = &state->queue[(state->head + state->count++) % HID_QUEUE_SIZE];
    memset(report, 0, sizeof(*report));
    return report;
}
void hid_reset(hid_state *state) { memset(state, 0, sizeof(*state)); }
bool hid_open(hid_state *state) {
    if (state->buttons || state->count) return false;
    state->active = true;
    return true;
}
bool hid_button(hid_state *state, uint32_t id, uint8_t buttons, uint32_t now) {
    if (!state->active || buttons > 3) return false;
    hid_report *report = append(state);
    if (!report) return false;
    state->buttons = buttons;
    *report = (hid_report){ .id=id, .time=now, .buttons=buttons };
    return true;
}
bool hid_move(hid_state *state, int32_t dx, int32_t dy, uint32_t now) {
    if (!state->active) return false;
    hid_report *report = state->count ? &state->queue[(state->head + state->count - 1) % HID_QUEUE_SIZE] : NULL;
    if (report && report->motion && report->buttons == state->buttons) {
        if ((uint32_t)(now - report->time) > 50) {
            state->dropped++;
            report->dx = report->dy = 0;
            report->time = now;
        }
    } else {
        report = append(state);
        if (!report) { state->dropped++; return false; }
        report->time = now; report->buttons = state->buttons; report->motion = true;
    }
    report->dx = clamp((int64_t)report->dx + dx, 32767);
    report->dy = clamp((int64_t)report->dy + dy, 32767);
    return true;
}
bool hid_scroll(hid_state *state, uint32_t id, int32_t wheel, uint32_t now) {
    if (!state->active || wheel < -127 || wheel > 127) return false;
    hid_report *report = append(state);
    if (!report) return false;
    *report = (hid_report){ .id=id, .time=now, .buttons=state->buttons, .wheel=wheel };
    return true;
}
void hid_stop(hid_state *state, uint32_t id, uint32_t now) {
    state->head = state->count = 0; state->buttons = 0; state->active = false;
    *append(state) = (hid_report){ .id=id, .time=now };
}
bool hid_media(hid_state *state, uint32_t id, uint16_t usage, uint32_t now) {
    if (state->count > HID_QUEUE_SIZE - 2) return false;
    *append(state) = (hid_report){ .time=now, .consumer=true, .usage=usage };
    *append(state) = (hid_report){ .id=id, .time=now, .consumer=true };
    return true;
}
void hid_pop(hid_state *state) {
    if (state->count) { state->head = (state->head + 1) % HID_QUEUE_SIZE; state->count--; }
}
bool hid_key(hid_state *state, uint32_t id, uint8_t usage, uint32_t now) {
    if (usage < 0x4f || usage > 0x52 || state->count > HID_QUEUE_SIZE - 2) return false;
    *append(state) = (hid_report){ .time=now, .keyboard=true, .usage=usage };
    *append(state) = (hid_report){ .id=id, .time=now, .keyboard=true };
    return true;
}
const hid_report *hid_peek(hid_state *state, uint32_t now) {
    while (state->count) {
        const hid_report *report = &state->queue[state->head];
        if (!report->motion || (uint32_t)(now - report->time) <= 75) return report;
        state->dropped++; hid_pop(state);
    }
    return NULL;
}
void hid_encode(const hid_report *report, uint8_t data[6]) {
    uint16_t dx = (uint16_t)clamp(report->dx, 32767), dy = (uint16_t)clamp(report->dy, 32767);
    data[0] = report->buttons;
    data[1] = (uint8_t)dx; data[2] = (uint8_t)(dx >> 8);
    data[3] = (uint8_t)dy; data[4] = (uint8_t)(dy >> 8);
    data[5] = (uint8_t)clamp(report->wheel, 127);
}
