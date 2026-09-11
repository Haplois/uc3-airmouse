#include <stdint.h>
#include <string.h>
#include "gatt_migration.h"
#include "compatible_gatt.h"

int migrate_gatt_subscriptions(const btstack_tlv_t *store, void *context, bool lg) {
    const uint32_t hash_tag = 0x42544442;
    const uint8_t *next = lg ? lg_schema_hash : current_schema_hash;
    uint8_t previous[16];
    if (store->get_tag(context, hash_tag, NULL, 0) != 16 ||
        store->get_tag(context, hash_tag, previous, sizeof(previous)) != 16 ||
        !memcmp(previous, next, 16)) return 0;
    bool known = !memcmp(previous, current_schema_hash, 16) || !memcmp(previous, lg_schema_hash, 16);
    for (unsigned i = 0; i < sizeof(compatible_hashes) / sizeof(compatible_hashes[0]); i++) {
        if (!memcmp(previous, compatible_hashes[i], 16)) known = true;
    }
    if (!known) return 0;
    if (store->store_tag(context, hash_tag, next, 16)) return -1;
    if (store->get_tag(context, hash_tag, previous, sizeof(previous)) != 16 ||
        memcmp(previous, next, 16)) return -1;
    return 1;
}
