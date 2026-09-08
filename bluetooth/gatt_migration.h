#pragma once
#include "btstack_tlv.h"

/* Returns 1 if migrated, 0 if unchanged/unknown, -1 on storage failure. */
int migrate_gatt_subscriptions(const btstack_tlv_t *store, void *context);
