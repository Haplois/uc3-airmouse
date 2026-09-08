#ifndef AIRMOUSE_HOST_REGISTRY_H
#define AIRMOUSE_HOST_REGISTRY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define HOSTS_LIMIT 4
#define HOSTS_NAME_BYTES 48

typedef struct {
    uint32_t id;
    uint8_t db_slot;
    uint8_t address_type;
    uint8_t address[6];
    char bluetooth_name[HOSTS_NAME_BYTES + 1];
    char custom_name[HOSTS_NAME_BYTES + 1];
} host_record;

typedef struct {
    uint8_t count;
    uint32_t next_id;
    uint32_t selected_id;
    uint32_t legacy_id;
    host_record records[HOSTS_LIMIT];
    char path[4096];
} host_registry;

/* Load returns 1 for existing metadata, 0 for a missing file, or -1 on error.
 * A mutation returning a storage error must stop its caller: after rename, a
 * failed directory fsync leaves the new state visible but not yet durable. */
int hosts_load(host_registry *registry, const char *path);
int hosts_save(host_registry *registry);
int hosts_add(host_registry *registry, uint8_t db_slot, uint8_t address_type,
              const uint8_t address[6], bool legacy, uint32_t *out_id);
int hosts_select(host_registry *registry, uint32_t id);
int hosts_rename(host_registry *registry, uint32_t id, const char *name);
int hosts_reorder(host_registry *registry, const uint32_t *ids, size_t count);
int hosts_forget(host_registry *registry, uint32_t id);
int hosts_set_bluetooth_name(host_registry *registry, uint32_t id, const char *name);
const host_record *hosts_by_id(const host_registry *registry, uint32_t id);
const host_record *hosts_by_slot(const host_registry *registry, uint8_t db_slot);
void hosts_name(const host_record *record, char *buffer, size_t size);
bool hosts_valid_text(const char *text, size_t length);

#endif
