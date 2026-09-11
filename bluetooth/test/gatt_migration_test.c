#include <assert.h>
#include <string.h>
#include "ble/att_server.c"
#include "airmouse_gatt.h"
#include "gatt_migration.h"
#include "compatible_gatt.h"
#include "lg_remote.h"
#include "ble/gatt-service/hids_device.h"

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
    uint16_t generic_start=0, generic_end=0xffff, lg_start=0, lg_end=0xffff;
    assert(gatt_server_get_handle_range_for_service_with_uuid16(0x1812,&generic_start,&generic_end));
    att_set_db(lg_gatt_database());
    assert(gatt_server_get_handle_range_for_service_with_uuid16(0x1812,&lg_start,&lg_end));
    assert(generic_start==lg_start && lg_end>generic_end);
    hids_device_report_t reports[LG_GATT_REPORT_COUNT];
    hids_device_init_with_storage(0,lg_descriptor,sizeof(lg_descriptor),LG_GATT_REPORT_COUNT,reports);
    const uint8_t ids[]={0xf9,0xf9,0xfd,0xfe,0xf9};
    const uint8_t types[]={1,3,1,1,2};
    const uint8_t sizes[]={30,200,30,124,200};
    for(unsigned i=0;i<5;i++) {
        assert(reports[i].id==ids[i] && reports[i].type==types[i] && reports[i].size==sizes[i]);
        assert((reports[i].client_configuration_handle!=0)==(types[i]==1));
    }
    att_set_db(profile_data);
    /* Exercise BTstack's actual validation after our startup migration. */
    memcpy(saved_hash,compatible_hashes[1],16);
    assert(memcmp(saved_hash,current_schema_hash,16) != 0);
    migrate_gatt_subscriptions(&store,NULL,false);
    assert(att_server_persistent_ccc_validate_database(&store,NULL));
    assert(deleted == 0 && stored == 1);
    assert(migrate_gatt_subscriptions(&store,NULL,false) == 0 && stored == 1);
    for(unsigned i=0;i<4;i++) {
        bool lg=(i%2)==0;
        att_set_db(lg?lg_gatt_database():profile_data);
        assert(migrate_gatt_subscriptions(&store,NULL,lg)==1);
        assert(att_server_persistent_ccc_validate_database(&store,NULL));
        assert(deleted==0);
    }
    memset(saved_hash,0xa5,16);
    assert(migrate_gatt_subscriptions(&store,NULL,false) == 0);
    assert(!att_server_persistent_ccc_validate_database(&store,NULL));
    assert(deleted == NVN_NUM_GATT_SERVER_CCC);
    memcpy(saved_hash,compatible_hashes[1],16); fail_write=true;
    assert(migrate_gatt_subscriptions(&store,NULL,false) == -1);
    return 0;
}
