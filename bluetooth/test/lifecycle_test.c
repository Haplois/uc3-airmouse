#define _GNU_SOURCE
#include <assert.h>
#include <sys/wait.h>
#define main daemon_main
#define gap_encryption_key_size fake_encryption_key_size
#define sm_le_device_index fake_device_index
#define gap_disconnect fake_disconnect
#define gap_advertisements_enable fake_advertise
#define gap_advertisements_set_params fake_advertising_params
#define gap_whitelist_clear fake_whitelist_clear
#define gap_whitelist_add fake_whitelist_add
#define gap_load_resolving_list_from_le_device_db fake_resolving_list
#define sm_request_pairing fake_request_pairing
#define sm_just_works_confirm fake_confirm_pairing
#define sm_bonding_decline fake_decline_pairing
#define le_device_db_count fake_db_count
#define le_device_db_info fake_db_info
#define le_device_db_remove fake_db_remove
#define gatt_client_read_value_of_characteristics_by_uuid16 fake_read_name
#define gatt_client_read_long_value_of_characteristic_using_value_handle fake_read_long_name
#define gap_request_connection_parameter_update fake_connection_update
#define hids_device_request_can_send_now_event fake_request_send
#define hids_device_send_input_report_for_id fake_send_report
#define hids_device_send_boot_mouse_input_report fake_send_boot
#define hids_device_init fake_hids_init
#define btstack_run_loop_get_time_ms fake_time
#define btstack_run_loop_set_timer fake_set_timer
#define btstack_run_loop_add_timer fake_add_timer
#include "../airmouse_hid.c"
#undef main

static uint32_t clock_ms;
static unsigned db_mask;
static uint16_t advertising_minimum, advertising_maximum;
static bool link_encrypted, synchronous_send;
static unsigned disconnects, requests, notifications, hids_resets;
static unsigned name_requests, long_name_requests, pairing_confirms, pairing_declines, pairing_requests, removed_bonds;
static unsigned whitelist_clears, whitelist_adds;
static int device_slot, advertising_enabled;
static uint8_t advertising_filter, whitelist_result, name_query_result, long_query_result;
static uint8_t whitelist_address[6];
static char registry_path[4096];
static btstack_packet_handler_t name_callback;
static uint8_t last_report[6];
static uint16_t last_report_size;
static void send_event(void);

uint8_t fake_encryption_key_size(hci_con_handle_t connection) {
    assert(connection == 1);
    return link_encrypted ? 16 : 0;
}
int fake_device_index(hci_con_handle_t connection) { assert(connection == 1); return device_slot; }
uint8_t fake_disconnect(hci_con_handle_t connection) { assert(connection == 1); disconnects++; return 0; }
void fake_advertise(int enabled) { advertising_enabled = enabled; }
void fake_advertising_params(uint16_t minimum, uint16_t maximum, uint8_t type, uint8_t direct_type,
        bd_addr_t direct, uint8_t channels, uint8_t filter) {
    assert(type == 0 && direct_type == 0 && channels == 7);
    advertising_minimum=minimum; advertising_maximum=maximum;
    assert(direct != NULL); advertising_filter = filter;
}
uint8_t fake_whitelist_clear(void) { whitelist_clears++; return ERROR_CODE_SUCCESS; }
uint8_t fake_whitelist_add(bd_addr_type_t type, const bd_addr_t address) {
    assert(type == BD_ADDR_TYPE_LE_PUBLIC); whitelist_adds++; memcpy(whitelist_address,address,6); return whitelist_result;
}
uint8_t fake_resolving_list(void) { return ERROR_CODE_SUCCESS; }
void fake_request_pairing(hci_con_handle_t connection) { assert(connection == 1); pairing_requests++; }
void fake_confirm_pairing(hci_con_handle_t connection) { assert(connection == 1); pairing_confirms++; }
void fake_decline_pairing(hci_con_handle_t connection) { assert(connection == 1); pairing_declines++; }
int fake_db_count(void) { return hosts.count; }
void fake_db_info(int index, int *type, bd_addr_t address, sm_key_t irk) {
    assert(index >= 0 && index < HOSTS_LIMIT);
    if(type) *type = (db_mask & (1u << index)) ? BD_ADDR_TYPE_LE_PUBLIC : BD_ADDR_TYPE_UNKNOWN;
    if(address) { memset(address,0,6); address[5]=(uint8_t)(index+1); }
    if(irk) memset(irk,0,16);
}
void fake_db_remove(int index) { assert(index >= 0 && index < HOSTS_LIMIT); removed_bonds++; db_mask &= ~(1u << index); }
uint8_t fake_read_name(btstack_packet_handler_t callback, hci_con_handle_t connection, uint16_t start, uint16_t end, uint16_t uuid) {
    assert(connection == 1 && start == 1 && end == 0xffff && uuid == 0x2a00);
    name_callback=callback; name_requests++; return name_query_result;
}
uint8_t fake_read_long_name(btstack_packet_handler_t callback, hci_con_handle_t connection, uint16_t value_handle) {
    assert(connection == 1 && value_handle == 0x42);
    name_callback=callback; long_name_requests++; return long_query_result;
}
int fake_connection_update(hci_con_handle_t connection, uint16_t minimum, uint16_t maximum, uint16_t latency, uint16_t timeout) {
    assert(connection == 1); assert(minimum == 6 && maximum == 6); assert(latency == 0 && timeout == 400); return 0;
}
uint8_t fake_request_send(hci_con_handle_t connection) {
    assert(connection == 1); requests++;
    if (synchronous_send) send_event();
    return 0;
}
static uint8_t capture(hci_con_handle_t connection, const uint8_t *report, uint16_t length) {
    assert(connection == 1); assert(length <= sizeof(last_report));
    memset(last_report, 0xff, sizeof(last_report)); memcpy(last_report, report, length);
    last_report_size = length; notifications++; return 0;
}
uint8_t fake_send_report(hci_con_handle_t connection, uint16_t id, const uint8_t *report, uint16_t length) {
    assert((id == 1 && length == 6) || (id == 2 && length == 2)); return capture(connection, report, length);
}
uint8_t fake_send_boot(hci_con_handle_t connection, const uint8_t *report, uint16_t length) {
    assert(length == 3); return capture(connection, report, length);
}
void fake_hids_init(uint8_t country, const uint8_t *map, uint16_t length) {
    assert(country == 0); assert(map == descriptor && length == sizeof(descriptor)); hids_resets++;
}
uint32_t fake_time(void) { return clock_ms; }
void fake_set_timer(btstack_timer_source_t *timer, uint32_t delay) { (void)timer; assert(delay == 50); }
void fake_add_timer(btstack_timer_source_t *timer) { (void)timer; }

static void hids_event(uint8_t event, uint8_t value) {
    uint8_t packet[] = {HCI_EVENT_HIDS_META, 4, event, 1, 0, value, 0};
    uint16_t length = 6;
    if (event == HIDS_SUBEVENT_INPUT_REPORT_ENABLE) { packet[1] = 5; packet[5] = 1; packet[6] = value; length = 7; }
    if (event == HIDS_SUBEVENT_CAN_SEND_NOW) { packet[1] = 3; length = 5; }
    radio_event(HCI_EVENT_PACKET, 0, packet, length);
}
static void send_event(void) { hids_event(HIDS_SUBEVENT_CAN_SEND_NOW, 0); }
static void disconnection_event(void) {
    uint8_t packet[] = {HCI_EVENT_DISCONNECTION_COMPLETE, 4, 0, 1, 0, 0x13};
    radio_event(HCI_EVENT_PACKET, 0, packet, sizeof(packet));
}
static void connection_event(void) {
    uint8_t packet[34] = {HCI_EVENT_META_GAP, 32, GAP_SUBEVENT_LE_CONNECTION_COMPLETE, 0, 1, 0};
    packet[26] = 6;
    radio_event(HCI_EVENT_PACKET, 0, packet, sizeof(packet));
}
static void request(const char *text) {
    char line[64]; assert(strlen(text) < sizeof(line)); strcpy(line, text); command(line);
}
static void reset(void) {
    hid_reset(&input);
    consumer_subscribed=false; sent_consumer=0; consumer_sent_at=0;
    fast_advertising=false; advertising_started=switch_started=switching_host=0; db_mask=15; clock_ms = 100; link_encrypted = true; synchronous_send = false;
    disconnects = requests = notifications = hids_resets = 0;
    memset(last_report, 0xff, sizeof(last_report)); last_report_size = 0;
    simulation = probe = initialized = send_requested = shutting_down = powering_off = false;
    subscribed = report_subscribed = boot_subscribed = stop_pending = false;
    working = true; handle = 1; trust_index = 0; protocol_mode = 1; sent_buttons = 0;
    client = listener = -1; tlv = NULL; highest_id = 0; input_used = output_used = 0;
    pairing_until = stop_time = connected_at = started_at = last_status = 0;
    reports_sent = 0; error_text = "";
    name_attempted=privacy_filter=name_clipped=false; name_host=pending_name_host=0;
    name_connection=HCI_CON_HANDLE_INVALID; name_phase=name_value_handle=name_received=0;
    memset(name_value,0,sizeof(name_value)); memset(pending_name,0,sizeof(pending_name));
    memset(&tlv_context,0,sizeof(tlv_context));
    name_requests=long_name_requests=pairing_confirms=pairing_declines=pairing_requests=removed_bonds=0;
    whitelist_clears=whitelist_adds=0; device_slot=0; advertising_enabled=0;
    advertising_filter=whitelist_result=name_query_result=long_query_result=0; name_callback=NULL;
    if(unlink(registry_path)<0) assert(errno==ENOENT);
    assert(hosts_load(&hosts,registry_path)==0);
    for(unsigned i=0;i<2;i++) {
        uint8_t address[6]={0,0,0,0,0,(uint8_t)(i+1)}; uint32_t id;
        assert(hosts_add(&hosts,(uint8_t)i,0,address,i==0,&id)==0);
        assert(hosts_set_bluetooth_name(&hosts,id,i==0?"Existing computer":"Other computer")==0);
    }
    assert(hosts_select(&hosts,1)==0); selected_changed();
}
static void ready_connection(void) {
    reset();
    hids_event(HIDS_SUBEVENT_INPUT_REPORT_ENABLE, 1);
    assert(!ready()); assert(requests == 1); assert(notifications == 0);
    send_event();
    assert(ready()); assert(last_report_size == 6);
    for (unsigned i = 0; i < sizeof(last_report); i++) assert(last_report[i] == 0);
}
static void hold(void) {
    ready_connection();
    request("OPEN 1"); request("BUTTON 2 1"); send_event();
    assert(input.active && sent_buttons == 1); assert(last_report[0] == 1);
}
static void test_unsubscribe_releases_by_disconnect(void) {
    hold();
    hids_event(HIDS_SUBEVENT_INPUT_REPORT_ENABLE, 0);
    assert(disconnects == 1); assert(!input.active); assert(!ready());
    assert(sent_buttons == 1); assert(stop_pending);
    disconnection_event();
    assert(sent_buttons == 0 && !stop_pending && input.count == 0);
}
static void test_inactive_cccd_does_not_change_readiness(void) {
    hold();
    unsigned before = notifications;
    hids_event(HIDS_SUBEVENT_BOOT_MOUSE_INPUT_REPORT_ENABLE, 1);
    hids_event(HIDS_SUBEVENT_BOOT_MOUSE_INPUT_REPORT_ENABLE, 0);
    assert(ready() && input.active && sent_buttons == 1);
    assert(disconnects == 0 && notifications == before);
    hids_event(HIDS_SUBEVENT_BOOT_MOUSE_INPUT_REPORT_ENABLE, 1);
    hids_event(HIDS_SUBEVENT_PROTOCOL_MODE, 0); send_event();
    assert(ready()); assert(last_report_size == 3); assert(last_report[0] == 0);
    hids_event(HIDS_SUBEVENT_INPUT_REPORT_ENABLE, 0);
    assert(ready() && subscribed && boot_subscribed && !report_subscribed);
}
static void test_reconnect_resets_protocol_and_sends_zero_first(void) {
    ready_connection();
    hids_event(HIDS_SUBEVENT_BOOT_MOUSE_INPUT_REPORT_ENABLE, 1);
    hids_event(HIDS_SUBEVENT_PROTOCOL_MODE, 0); send_event();
    assert(protocol_mode == 0 && last_report_size == 3);
    disconnection_event();
    assert(protocol_mode == 1 && hids_resets == 1);
    assert(!report_subscribed && !boot_subscribed && !subscribed && !initialized);
    connection_event();
    unsigned before = notifications;
    hids_event(HIDS_SUBEVENT_INPUT_REPORT_ENABLE, 1);
    assert(!ready() && notifications == before);
    send_event();
    assert(ready() && last_report_size == 6 && notifications == before + 1);
    for (unsigned i = 0; i < sizeof(last_report); i++) assert(last_report[i] == 0);
}
static void test_repeated_stop_keeps_original_deadline(void) {
    hold();
    request("STOP 3"); assert(stop_pending && stop_time == 100);
    clock_ms = 200; request("STOP 4");
    clock_ms = 300; request("STOP 5"); assert(stop_time == 100);
    clock_ms = 349; tick_event(&tick); assert(disconnects == 0);
    clock_ms = 350; tick_event(&tick); assert(disconnects == 1 && !input.active);
}
static void test_encryption_loss_stops_and_disconnects(void) {
    hold(); link_encrypted = false;
    uint8_t packet[] = {HCI_EVENT_ENCRYPTION_CHANGE, 4, 0, 1, 0, 0};
    radio_event(HCI_EVENT_PACKET, 0, packet, sizeof(packet));
    assert(!input.active && !ready()); assert(disconnects == 1);
    assert(sent_buttons == 1 && stop_pending);
}
static void test_synchronous_send_callback_finishes_zero(void) {
    reset(); synchronous_send = true;
    hids_event(HIDS_SUBEVENT_INPUT_REPORT_ENABLE, 1);
    assert(ready() && notifications == 1 && input.count == 0);
    assert(!send_requested && !stop_pending && sent_buttons == 0);
}

static void name_value_event(bool long_value, uint16_t offset, const char *value, size_t length, uint16_t connection) {
    uint8_t packet[128]={0};
    size_t header=long_value?14:12;
    assert(length+header<=sizeof(packet));
    packet[0]=long_value?GATT_EVENT_LONG_CHARACTERISTIC_VALUE_QUERY_RESULT:GATT_EVENT_CHARACTERISTIC_VALUE_QUERY_RESULT;
    packet[1]=(uint8_t)(length+header-2);
    little_endian_store_16(packet,2,connection);
    little_endian_store_16(packet,8,0x42);
    if(long_value) little_endian_store_16(packet,10,offset);
    little_endian_store_16(packet,long_value?12:10,(uint16_t)length);
    memcpy(packet+header,value,length);
    assert(name_callback);
    name_callback(HCI_EVENT_PACKET,0,packet,(uint16_t)(length+header));
}
static void name_complete(uint8_t status, uint16_t connection) {
    uint8_t packet[]={GATT_EVENT_QUERY_COMPLETE,7,0,0,0,0,0,0,status};
    little_endian_store_16(packet,2,connection);
    assert(name_callback);
    name_callback(HCI_EVENT_PACKET,0,packet,sizeof(packet));
}
static void start_long_name(void) {
    assert(name_requests==1 && name_phase==1 && ready());
    name_value_event(false,0,"Discovery prefix",16,1);
    name_complete(ATT_ERROR_SUCCESS,1);
    assert(long_name_requests==1 && name_phase==2 && ready());
}
static void test_name_fragments_persist_without_overwriting_alias(void) {
    ready_connection();
    assert(hosts_rename(&hosts,1,"Custom desk")==0);
    start_long_name();
    const char name[]="Desk \"PC\" \\ \xe6\xa1\x8c \xf0\x9f\x92\xbb";
    name_value_event(true,0,name,14,1);
    name_value_event(true,14,name+14,sizeof(name)-1-14,1);
    name_complete(ATT_ERROR_SUCCESS,1);
    assert(pending_name_host==1 && ready());
    assert(!strcmp(hosts_by_id(&hosts,1)->bluetooth_name,"Existing computer"));
    tick_event(&tick);
    assert(!pending_name_host);
    assert(!strcmp(hosts_by_id(&hosts,1)->bluetooth_name,name));
    assert(!strcmp(hosts_by_id(&hosts,1)->custom_name,"Custom desk"));
    host_registry loaded;
    assert(hosts_load(&loaded,registry_path)==1);
    assert(!strcmp(hosts_by_id(&loaded,1)->bluetooth_name,name));
    assert(ready() && !input.active && notifications==1);
}
static void test_name_storage_waits_for_pointer_stop(void) {
    hold(); start_long_name();
    name_value_event(true,0,"New Bluetooth name",18,1); name_complete(ATT_ERROR_SUCCESS,1);
    assert(pending_name_host==1);
    tick_event(&tick);
    assert(!strcmp(hosts_by_id(&hosts,1)->bluetooth_name,"Existing computer"));
    request("STOP 3"); send_event(); tick_event(&tick);
    assert(!strcmp(hosts_by_id(&hosts,1)->bluetooth_name,"New Bluetooth name"));
    assert(!input.active && ready() && last_report[0]==0);
}
static void test_name_query_errors_preserve_name_and_input_readiness(void) {
    reset(); name_query_result=ERROR_CODE_COMMAND_DISALLOWED;
    hids_event(HIDS_SUBEVENT_INPUT_REPORT_ENABLE,1); send_event();
    assert(ready() && !name_phase && !pending_name_host && name_requests==1);
    query_host_name(); assert(name_requests==1);

    ready_connection();
    name_complete(ATT_ERROR_ATTRIBUTE_NOT_FOUND,1);
    assert(!name_phase && !pending_name_host && ready());

    ready_connection(); long_query_result=ERROR_CODE_COMMAND_DISALLOWED;
    name_value_event(false,0,"Partial",7,1); name_complete(ATT_ERROR_SUCCESS,1);
    assert(!name_phase && !pending_name_host && ready());

    ready_connection(); start_long_name();
    name_value_event(true,0,"Partial changed value",21,1);
    name_complete(ATT_ERROR_READ_NOT_PERMITTED,1); tick_event(&tick);
    assert(!pending_name_host && ready());
    assert(!strcmp(hosts_by_id(&hosts,1)->bluetooth_name,"Existing computer"));
    assert(!disconnects);
}
static void test_name_late_callbacks_cannot_update_another_selection(void) {
    ready_connection(); start_long_name();
    request("SELECT 1 00000002");
    assert(hosts.selected_id==2 && disconnects==1 && !ready());
    name_value_event(true,0,"Old host result",15,1); name_complete(ATT_ERROR_SUCCESS,1);
    assert(!pending_name_host);
    assert(!strcmp(hosts_by_id(&hosts,1)->bluetooth_name,"Existing computer"));
    assert(!strcmp(hosts_by_id(&hosts,2)->bluetooth_name,"Other computer"));

    ready_connection(); start_long_name();
    name_value_event(true,0,"Wrong connection",16,2); name_complete(ATT_ERROR_SUCCESS,2);
    assert(!pending_name_host && name_phase==2);
    disconnection_event();
    name_value_event(true,0,"Disconnected result",19,1); name_complete(ATT_ERROR_SUCCESS,1);
    assert(!pending_name_host && !name_phase);
}
static void test_name_clipped_utf8_and_invalid_values(void) {
    ready_connection(); start_long_name();
    char value[64]; memset(value,'x',47); memcpy(value+47,"\xf0\x9f\x92\xbb",4);
    name_value_event(true,0,value,51,1); name_complete(ATT_ERROR_SUCCESS,1); tick_event(&tick);
    assert(strlen(hosts_by_id(&hosts,1)->bluetooth_name)==47);
    assert(hosts_valid_text(hosts_by_id(&hosts,1)->bluetooth_name,47));

    const char *bad[]={"bad\nname","bad\xed\xa0\x80","bad\xc0\xaf","bad\xc2","bad\x7f"};
    for(unsigned i=0;i<sizeof(bad)/sizeof(bad[0]);i++) {
        ready_connection(); start_long_name();
        name_value_event(true,0,bad[i],strlen(bad[i]),1); name_complete(ATT_ERROR_SUCCESS,1); tick_event(&tick);
        assert(!pending_name_host && ready());
        assert(!strcmp(hosts_by_id(&hosts,1)->bluetooth_name,"Existing computer"));
    }
    ready_connection(); start_long_name();
    name_value_event(true,0,"Bad\0Name",8,1); name_complete(ATT_ERROR_SUCCESS,1); tick_event(&tick);
    assert(!strcmp(hosts_by_id(&hosts,1)->bluetooth_name,"Existing computer"));
    ready_connection(); start_long_name();
    name_value_event(true,1,"Out of order",12,1); name_complete(ATT_ERROR_SUCCESS,1);
    assert(!pending_name_host && !name_phase && ready());
}
static void encryption_event(void) {
    uint8_t packet[]={HCI_EVENT_ENCRYPTION_CHANGE,4,0,1,0,1};
    radio_event(HCI_EVENT_PACKET,0,packet,sizeof(packet));
}
static void identity_event(uint16_t slot) {
    uint8_t packet[20]={SM_EVENT_IDENTITY_RESOLVING_SUCCEEDED,18,1,0};
    little_endian_store_16(packet,18,slot);
    radio_event(HCI_EVENT_PACKET,0,packet,sizeof(packet));
}
static void sm_event(uint8_t type) {
    uint8_t packet[]={type,2,1,0};
    radio_event(HCI_EVENT_PACKET,0,packet,sizeof(packet));
}
static void test_only_selected_host_can_receive_reports(void) {
    reset(); device_slot=1;
    hids_event(HIDS_SUBEVENT_INPUT_REPORT_ENABLE,1);
    assert(!ready() && !requests && !notifications);
    request("OPEN 1"); request("BUTTON 2 1");
    assert(!input.active && !input.count);
    encryption_event(); assert(disconnects==1);

    reset(); identity_event(1); assert(disconnects==1);
    reset(); identity_event(0); assert(disconnects==0);
    hold(); device_slot=1; encryption_event();
    unsigned before=notifications;
    request("MOVE 0 10 10"); send_event();
    assert(!ready() && notifications==before && disconnects==1);
    disconnection_event();
    assert(!input.active && !sent_buttons && !input.count);
}
static void test_pairing_window_rejects_known_hosts_and_gates_new_pairing(void) {
    reset(); device_slot=2;
    sm_event(SM_EVENT_JUST_WORKS_REQUEST);
    assert(pairing_declines==1 && !pairing_confirms);
    pairing_until=clock_ms+60000;
    sm_event(SM_EVENT_JUST_WORKS_REQUEST);
    assert(pairing_confirms==1);
    device_slot=0; sm_event(SM_EVENT_JUST_WORKS_REQUEST);
    assert(pairing_declines==2 && pairing_confirms==1);
    identity_event(0); assert(disconnects==1);
    sm_event(SM_EVENT_NUMERIC_COMPARISON_REQUEST); assert(pairing_declines==3);
    for(unsigned i=2;i<4;i++) {
        uint8_t address[6]={0,0,0,0,0,(uint8_t)(i+1)};
        assert(hosts_add(&hosts,(uint8_t)i,0,address,false,NULL)==0);
    }
    device_slot=-1; sm_event(SM_EVENT_JUST_WORKS_REQUEST);
    assert(pairing_declines==4 && pairing_confirms==1);
}
static void pairing_complete(void) {
    uint8_t packet[14]={SM_EVENT_PAIRING_COMPLETE,12,1,0};
    radio_event(HCI_EVENT_PACKET,0,packet,sizeof(packet));
}
static void test_new_bond_registration_requires_pairing_and_persists_selection(void) {
    reset(); device_slot=2;
    pairing_complete();
    assert(disconnects==1 && removed_bonds==1 && hosts.count==2 && hosts.selected_id==1);

    reset(); device_slot=2; pairing_until=clock_ms+60000;
    pairing_complete();
    assert(!pairing() && !removed_bonds && !disconnects);
    assert(hosts.count==3 && hosts.selected_id==3 && trust_index==2 && !ready());
    const host_record *added=hosts_by_id(&hosts,3);
    assert(added && added->db_slot==2 && added->address_type==0 && added->address[5]==3);
    host_registry loaded; assert(hosts_load(&loaded,registry_path)==1 && loaded.selected_id==3);
    hids_event(HIDS_SUBEVENT_INPUT_REPORT_ENABLE,1); assert(!ready()); send_event();
    assert(ready() && !input.active && last_report[0]==0);

    reset(); pairing_until=clock_ms+60000; device_slot=0;
    pairing_complete();
    assert(disconnects==1 && hosts.count==2 && hosts.selected_id==1 && pairing());
}
static void test_advertising_filters_selected_identity_and_pairing_is_open(void) {
    reset(); handle=HCI_CON_HANDLE_INVALID; privacy_filter=true;
    advertise();
    assert(advertising_enabled && advertising_filter==2 && whitelist_adds==1);
    assert(!memcmp(whitelist_address,hosts_by_id(&hosts,1)->address,6));
    pairing_until=clock_ms+60000; advertise();
    assert(advertising_enabled && advertising_filter==0 && whitelist_adds==1);
    pairing_until=0; whitelist_result=ERROR_CODE_MEMORY_CAPACITY_EXCEEDED; advertise();
    assert(!advertising_enabled && strstr(error_text,"filter unavailable"));
    whitelist_result=0;
    assert(hosts_select(&hosts,0)==0); advertise();
    assert(!advertising_enabled);
}
static void test_stale_pairing_events_and_cancel_leave_current_link(void) {
    ready_connection();
    request("CANCEL_PAIR 1");
    assert(ready() && disconnects==0);
    pairing_until=clock_ms+60000; device_slot=2;
    uint8_t complete[13]={SM_EVENT_PAIRING_COMPLETE,11,2,0};
    radio_event(HCI_EVENT_PACKET,0,complete,sizeof(complete));
    uint8_t just_works[]={SM_EVENT_JUST_WORKS_REQUEST,2,2,0};
    radio_event(HCI_EVENT_PACKET,0,just_works,sizeof(just_works));
    uint8_t comparison[]={SM_EVENT_NUMERIC_COMPARISON_REQUEST,2,2,0};
    radio_event(HCI_EVENT_PACKET,0,comparison,sizeof(comparison));
    assert(hosts.count==2 && hosts.selected_id==1 && !pairing_confirms && !pairing_declines && !removed_bonds && !disconnects);
    complete[2]=1; complete[11]=ERROR_CODE_AUTHENTICATION_FAILURE;
    radio_event(HCI_EVENT_PACKET,0,complete,sizeof(complete));
    assert(disconnects==1 && pairing() && hosts.count==2);
}
static void test_legacy_migration_and_forgotten_bond_cleanup(void) {
    reset();
    assert(unlink(registry_path)==0);
    char directory[sizeof(registry_path)]; strcpy(directory,registry_path);
    *strrchr(directory,'/')=0;
    const char *previous=state_dir; state_dir=directory;
    db_mask=8; trust_index=3;
    load_hosts();
    assert(hosts.count==1 && hosts.selected_id==1 && hosts.legacy_id==1);
    assert(hosts.records[0].db_slot==3 && hosts.records[0].address[5]==4 && removed_bonds==0);
    assert(hosts_rename(&hosts,1,"Preserved alias")==0);
    load_hosts();
    assert(hosts.next_id==2 && !strcmp(hosts.records[0].custom_name,"Preserved alias"));
    pid_t child=fork(); assert(child>=0);
    if(!child) {
        assert(freopen("/dev/null","w",stderr));
        db_mask=0; load_hosts(); _exit(0);
    }
    int status; assert(waitpid(child,&status,0)==child);
    assert(WIFEXITED(status) && WEXITSTATUS(status)==1);
    assert(hosts_forget(&hosts,1)==0);
    trust_index=3;
    load_hosts();
    assert(hosts.count==0 && hosts.selected_id==0 && hosts.next_id==2);
    assert(removed_bonds==1 && db_mask==0);
    state_dir=previous;
}
static void test_reconnect_advertises_at_twenty_milliseconds(void) {
    reset(); disconnection_event();
    assert(advertising_minimum==0x20 && advertising_maximum==0x20);
    clock_ms+=29999; tick_event(&tick);
    assert(fast_advertising && advertising_minimum==0x20);
    clock_ms++; tick_event(&tick);
    assert(!fast_advertising && advertising_minimum==0x30 && advertising_maximum==0x60);
    request("SELECT 1 00000002");
    assert(fast_advertising && advertising_minimum==0x20 && advertising_maximum==0x20);
    assert(switching_host==2 && switch_started==clock_ms);
}
static void test_media_while_paused_and_stop_release(void) {
    ready_connection(); consumer_subscribed=true;
    request("MEDIA 1 205");
    assert(!input.active && input.count==2);
    send_event(); assert(sent_consumer==205 && last_report_size==2 && last_report[0]==205);
    request("STOP 2");
    send_event(); send_event();
    assert(sent_consumer==0 && !stop_pending && ready());
    request("MEDIA 3 233"); send_event(); send_event();
    assert(!sent_consumer && !input.count && ready());
    consumer_subscribed=false; request("MEDIA 4 205"); assert(!input.count);
}
static void test_media_encryption_loss_disconnects(void) {
    ready_connection(); consumer_subscribed=true;
    request("MEDIA 1 205"); send_event();
    link_encrypted=false; stop_input(0); assert(disconnects==1);
}
int main(void) {
    unsetenv("NOTIFY_SOCKET");
    char directory[]="/tmp/airmouse-lifecycle-test-XXXXXX";
    assert(mkdtemp(directory));
    assert(snprintf(registry_path,sizeof(registry_path),"%s/hosts.dat",directory)>0);
    test_unsubscribe_releases_by_disconnect();
    test_media_while_paused_and_stop_release();
    test_media_encryption_loss_disconnects();
    test_inactive_cccd_does_not_change_readiness();
    test_reconnect_resets_protocol_and_sends_zero_first();
    test_repeated_stop_keeps_original_deadline();
    test_encryption_loss_stops_and_disconnects();
    test_synchronous_send_callback_finishes_zero();
    test_name_fragments_persist_without_overwriting_alias();
    test_name_storage_waits_for_pointer_stop();
    test_name_query_errors_preserve_name_and_input_readiness();
    test_name_late_callbacks_cannot_update_another_selection();
    test_name_clipped_utf8_and_invalid_values();
    test_only_selected_host_can_receive_reports();
    test_pairing_window_rejects_known_hosts_and_gates_new_pairing();
    test_new_bond_registration_requires_pairing_and_persists_selection();
    test_advertising_filters_selected_identity_and_pairing_is_open();
    test_reconnect_advertises_at_twenty_milliseconds();
    test_stale_pairing_events_and_cancel_leave_current_link();
    test_legacy_migration_and_forgotten_bond_cleanup();
    assert(unlink(registry_path)==0);
    assert(rmdir(directory)==0);
    puts("Eighteen Bluetooth lifecycle regression tests passed");
    return 0;
}
