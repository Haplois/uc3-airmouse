#ifndef AIRMOUSE_LG_REMOTE_H
#define AIRMOUSE_LG_REMOTE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LG_MOTION_REPORT 0xfd
#define LG_CONTROL_REPORT 0xf9
#define LG_COMMAND_REPORT 0xf9
#define LG_GATT_REPORT_COUNT 5
#define LG_MOTION_SIZE 19
#define LG_MOTION_START 0x803e
#define LG_MOTION_STOP 0x803f

typedef struct {
    uint8_t sequence;
    bool motion_requested;
    bool start_pending;
    bool motion_running;
    bool stop_pending;
} lg_remote;

extern const uint8_t lg_descriptor[202];
const uint8_t *lg_gatt_database(void);
void lg_encode(uint8_t out[LG_MOTION_SIZE], uint8_t status_byte, uint8_t sequence,
               uint8_t battery, bool pointing, const int16_t axes[6], uint16_t key, int8_t wheel);
size_t lg_command(lg_remote *remote, const uint8_t *command, size_t length, uint8_t response[30]);
bool lg_key_supported(uint16_t key);
void lg_begin_motion(lg_remote *remote);
void lg_end_motion(lg_remote *remote);
uint8_t lg_motion_sequence(lg_remote *remote);
#endif
