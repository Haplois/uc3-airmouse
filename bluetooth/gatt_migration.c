#include <stdint.h>
#include <string.h>
#include "gatt_migration.h"
#include "compatible_gatt.h"

int migrate_gatt_subscriptions(const btstack_tlv_t *store, void *context) {
    const uint32_t hash_tag = 0x42544442;
    uint8_t previous[16];
    if (store->get_tag(context, hash_tag, NULL, 0) != 16 ||
        store->get_tag(context, hash_tag, previous, sizeof(previous)) != 16 ||
        !memcmp(previous, current_schema_hash, 16)) return 0;
    for (unsigned i = 0; i < sizeof(compatible_hashes) / sizeof(compatible_hashes[0]); i++) {
        if (memcmp(previous, compatible_hashes[i], 16)) continue;
        if (store->store_tag(context, hash_tag, current_schema_hash, 16)) return -1;
        if (store->get_tag(context, hash_tag, previous, sizeof(previous)) != 16 ||
            memcmp(previous, current_schema_hash, 16)) return -1;
        return 1;
    }
    return 0;
}
