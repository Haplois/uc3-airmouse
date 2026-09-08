#include <assert.h>
#include <string.h>
#include "ble/att_server.c"
#include "airmouse_gatt.h"
#include "gatt_migration.h"
#include "compatible_gatt.h"

static uint8_t saved_hash[16];
static unsigned deleted, stored;
static bool fail_write;
static int get(void *ctx, uint32_t tag, uint8_t *value, uint32_t size) {
    (void)ctx;
    if (tag != 0x42544442) return 0;
    if (value) memcpy(value, saved_hash, size < 16 ? size : 16);
    return 16;
}
static int put(void *ctx, uint32_t tag, const uint8_t *value, uint32_t size) {
    (void)ctx; assert(tag == 0x42544442 && size == 16);
    if (fail_write) return -1;
    memcpy(saved_hash,value,16); stored++; return 0;
}
static void remove_tag(void *ctx, uint32_t tag) {
    (void)ctx; assert((tag >> 8) == 0x425443); deleted++;
}
int main(void) {
    const btstack_tlv_t store = {.get_tag=get,.store_tag=put,.delete_tag=remove_tag};
    att_set_db(profile_data);
    /* Exercise BTstack's actual validation after our startup migration. */
    memcpy(saved_hash,compatible_hashes[1],16);
    assert(memcmp(saved_hash,current_schema_hash,16) != 0);
    migrate_gatt_subscriptions(&store,NULL);
    assert(att_server_persistent_ccc_validate_database(&store,NULL));
    assert(deleted == 0 && stored == 1);
    assert(migrate_gatt_subscriptions(&store,NULL) == 0 && stored == 1);
    memset(saved_hash,0xa5,16);
    assert(migrate_gatt_subscriptions(&store,NULL) == 0);
    assert(!att_server_persistent_ccc_validate_database(&store,NULL));
    assert(deleted == NVN_NUM_GATT_SERVER_CCC);
    memcpy(saved_hash,compatible_hashes[1],16); fail_write=true;
    assert(migrate_gatt_subscriptions(&store,NULL) == -1);
    return 0;
}
