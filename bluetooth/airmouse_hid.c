#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/random.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include "btstack.h"
#include "btstack_chipset_bcm.h"
#include "btstack_run_loop_posix.h"
#include "btstack_tlv_posix.h"
#include "btstack_uart.h"
#include "hci_transport_h4.h"
#include "ble/le_device_db_tlv.h"
#include "ble/gatt-service/hids_device.h"
#include "ble/gatt-service/battery_service_server.h"
#include "airmouse_gatt.h"
#include "gatt_migration.h"
#include "hid_state.h"
#include "host_registry.h"
#include "lg_remote.h"

#define LEASE_MS 1000u
#define RELEASE_MS 250u
#define TRUST_TAG 0x414d4853u
static const uint8_t descriptor[] = {
    0x05,0x01,0x09,0x02,0xa1,0x01,0x85,0x01,0x09,0x01,0xa1,0x00,
    0x05,0x09,0x19,0x01,0x29,0x03,0x15,0x00,0x25,0x01,0x95,0x03,0x75,0x01,0x81,0x02,
    0x95,0x01,0x75,0x05,0x81,0x03,
    0x05,0x01,0x09,0x30,0x09,0x31,0x16,0x01,0x80,0x26,0xff,0x7f,0x75,0x10,0x95,0x02,0x81,0x06,
    0x09,0x38,0x15,0x81,0x25,0x7f,0x75,0x08,0x95,0x01,0x81,0x06,0xc0,0xc0,
    0x05,0x0c,0x09,0x01,0xa1,0x01,0x85,0x02,
    0x15,0x00,0x26,0xff,0x03,0x19,0x00,0x2a,0xff,0x03,
    0x75,0x10,0x95,0x01,0x81,0x00,0xc0,
    0x05,0x01,0x09,0x06,0xa1,0x01,0x85,0x03,
    0x05,0x07,0x15,0x00,0x26,0xe3,0x00,0x19,0x00,0x29,0xe3,
    0x75,0x08,0x95,0x01,0x81,0x00,0xc0
};
static uint8_t advertising[] = {
    2,BLUETOOTH_DATA_TYPE_FLAGS,6,
    19,BLUETOOTH_DATA_TYPE_COMPLETE_LOCAL_NAME,'R','e','m','o','t','e',' ','3',' ','A','i','r',' ','m','o','u','s','e',
    3,BLUETOOTH_DATA_TYPE_COMPLETE_LIST_OF_16_BIT_SERVICE_CLASS_UUIDS,0x12,0x18,
    3,BLUETOOTH_DATA_TYPE_APPEARANCE,0xc2,0x03
};
static uint8_t lg_advertising[] = {
    2,BLUETOOTH_DATA_TYPE_FLAGS,5,
    23,BLUETOOTH_DATA_TYPE_MANUFACTURER_SPECIFIC_DATA,0xc4,0x00,
    'S','C','D',' ','2','1','.','2',',','B','A',' ','3','5',',','w','e','b','O','S'
};
static uint8_t lg_scan_response[] = {
    9,BLUETOOTH_DATA_TYPE_COMPLETE_LOCAL_NAME,'L','G','E',' ','M','R','2','3'
};
static bool lg_profile, lg_pairing, simulation_lg, control_subscribed;
static lg_remote magic;
static hids_device_report_t lg_report_storage[LG_GATT_REPORT_COUNT];
static struct { uint8_t bytes[30]; uint8_t length; } control_queue[8];
static unsigned control_head, control_count;
static int16_t last_axes[6]={0,0,0,0,0,-4096};
static uint8_t remote_battery=63;
static hid_state input;
static hci_con_handle_t handle = HCI_CON_HANDLE_INVALID;
static btstack_packet_callback_registration_t hci_events, sm_events;
static btstack_data_source_t listener_ds, client_ds, signal_ds;
static btstack_timer_source_t tick;
static btstack_tlv_posix_t tlv_context;
static const btstack_tlv_t *tlv;
static int listener = -1, client = -1, trust_index = -1;
static host_registry hosts;
static bool privacy_filter, name_attempted;
static uint32_t advertising_started, switch_started, switching_host;
static bool fast_advertising;
static uint32_t name_host, pending_name_host;
static hci_con_handle_t name_connection = HCI_CON_HANDLE_INVALID;
static uint16_t name_value_handle, name_received;
static unsigned name_phase;
static bool name_clipped;
static char name_value[HOSTS_NAME_BYTES+1], pending_name[HOSTS_NAME_BYTES+1];
static uid_t client_uid;
static bool simulation, probe, working, subscribed, initialized, send_requested, shutting_down, powering_off;
static bool stop_pending, report_subscribed, boot_subscribed;
static bool consumer_subscribed;
static uint16_t sent_consumer;
static uint32_t consumer_sent_at;
static bool keyboard_subscribed;
static uint16_t sent_key;
static uint32_t key_sent_at;
static uint8_t protocol_mode = 1, sent_buttons;
static uint32_t highest_id, last_seen, stop_time, pairing_until, connected_at, started_at, last_status;
static uint16_t interval_units;
static uint32_t simulation_interval, simulation_last;
static unsigned simulation_hosts=1;
static uint64_t reports_sent;
static uint32_t last_battery;
static char input_buffer[128], output_buffer[8192];
static size_t input_used, output_used;
static const char *error_text = "";
static const char *socket_path = "/run/airmouse-bt/control.sock";
static const char *state_dir = "/mnt/data/airmouse/bluetooth/state";
static const char *firmware_path = "/opt/uc/bt/fw/init/BCM4373A0_001.001.025.0103.0155.FCC.CE.2BC.hcd";
static bool paired(void) { return hosts.count > 0; }
static uint32_t now_ms(void) { return btstack_run_loop_get_time_ms(); }
static bool pairing(void) { return pairing_until && (int32_t)(pairing_until - now_ms()) > 0; }
static uint32_t connected_host(void) {
    if (simulation) return hosts.selected_id;
    if (handle == HCI_CON_HANDLE_INVALID || gap_encryption_key_size(handle) != 16) return 0;
    int slot=sm_le_device_index(handle);
    const host_record *host=slot>=0 && slot<HOSTS_LIMIT ? hosts_by_slot(&hosts,(uint8_t)slot) : NULL;
    return host?host->id:0;
}
static bool encrypted(void) { return hosts.selected_id && connected_host()==hosts.selected_id && !pairing(); }
static bool available(void) { return working && (simulation || handle != HCI_CON_HANDLE_INVALID) && subscribed && encrypted(); }
static bool ready(void) { return available() && initialized && !stop_pending && !shutting_down; }
static void pump(void);
static void close_client(void);
static void stop_input(uint32_t id);
static void send_status(void);
static void notify_service(const char *message);
static void query_host_name(void);
static void advertise(void);
static void reconnect_advertising(void);
static void configure_profile(void);
static bool control_ready(void) {
    return lg_profile && control_subscribed && control_count && working && encrypted() && !shutting_down;
}

static void fatal(const char *message) { fprintf(stderr,"airmouse-hid: %s: %s\n",message,strerror(errno)); exit(1); }
static void flush_output(void) {
    while (client >= 0 && output_used) {
        ssize_t written = send(client,output_buffer,output_used,MSG_NOSIGNAL);
        if (written > 0) { memmove(output_buffer,output_buffer+written,output_used-(size_t)written); output_used-=(size_t)written; }
        else if (written < 0 && errno == EINTR) continue;
        else if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        else { close_client(); return; }
    }
    if (client >= 0) {
        if (output_used) btstack_run_loop_enable_data_source_callbacks(&client_ds,DATA_SOURCE_CALLBACK_WRITE);
        else btstack_run_loop_disable_data_source_callbacks(&client_ds,DATA_SOURCE_CALLBACK_WRITE);
    }
}
static void output(const char *line) {
    if (client < 0) return;
    size_t size = strlen(line);
    if (size > sizeof(output_buffer)-output_used) { close_client(); return; }
    memcpy(output_buffer+output_used,line,size); output_used+=size; flush_output();
}
static void reply(uint32_t id, const char *error) {
    if (!id) return;
    char line[256];
    if (error) snprintf(line,sizeof(line),"{\"id\":%"PRIu32",\"ok\":false,\"error\":\"%s\"}\n",id,error);
    else snprintf(line,sizeof(line),"{\"id\":%"PRIu32",\"ok\":true}\n",id);
    output(line);
}
static void json_string(const char *value, char *out, size_t capacity) {
    size_t used=0;
    for(const unsigned char *p=(const unsigned char*)value;*p;p++) {
        if(used+3>=capacity) { errno=EOVERFLOW; fatal("Status string"); }
        if(*p=='"' || *p=='\\') out[used++]='\\';
        out[used++]=(char)*p;
    }
    out[used]=0;
}
static void send_status(void) {
    char line[4096],selected[9]="",connected[9]="";
    if(hosts.selected_id) snprintf(selected,sizeof(selected),"%08"PRIx32,hosts.selected_id);
    uint32_t current=connected_host();
    if(current) snprintf(connected,sizeof(connected),"%08"PRIx32,current);
    int used=snprintf(line,sizeof(line),"{\"version\":2,\"state\":{\"working\":%s,\"ready\":%s,\"paired\":%s,\"pairing\":%s,\"connected\":%s,\"active\":%s,\"buttons\":%u,\"interval_ms\":%.2f,\"reports_sent\":%"PRIu64",\"dropped_motion\":%"PRIu32",\"error\":\"%s\",\"selected\":\"%s\",\"connected_device\":\"%s\",\"host_limit\":4,\"devices\":[",
        working?"true":"false",ready()?"true":"false",paired()?"true":"false",pairing()?"true":"false",
        (simulation || handle!=HCI_CON_HANDLE_INVALID)?"true":"false",input.active?"true":"false",input.buttons,interval_units*1.25,reports_sent,input.dropped,error_text,selected,connected);
    for(unsigned i=0;i<hosts.count;i++) {
        const host_record *host=&hosts.records[i];
        char label[64],name[130],bluetooth[100],custom[100];
        hosts_name(host,label,sizeof(label)); json_string(label,name,sizeof(name));
        json_string(host->bluetooth_name,bluetooth,sizeof(bluetooth)); json_string(host->custom_name,custom,sizeof(custom));
        if(used<0 || (size_t)used>=sizeof(line)) { errno=EOVERFLOW; fatal("Status"); }
        used+=snprintf(line+used,sizeof(line)-(size_t)used,"%s{\"id\":\"%08"PRIx32"\",\"name\":\"%s\",\"bluetooth_name\":\"%s\",\"custom_name\":\"%s\",\"legacy\":%s}",i?",":"",host->id,name,bluetooth,custom,host->id==hosts.legacy_id?"true":"false");
    }
    if(used<0 || (size_t)used+5>=sizeof(line)) { errno=EOVERFLOW; fatal("Status"); }
    strcpy(line+used,"]}}\n"); output(line);
}
static void cancel_queued(const char *reason) {
    uint32_t ids[HID_QUEUE_SIZE]; unsigned count=input.count;
    for(unsigned i=0;i<count;i++) ids[i]=input.queue[(input.head+i)%HID_QUEUE_SIZE].id;
    input.head=input.count=0;
    for(unsigned i=0;i<count;i++) reply(ids[i],reason);
}
static void disconnect_host(void) {
    control_subscribed=false; control_count=0;
    if (handle!=HCI_CON_HANDLE_INVALID && !simulation) gap_disconnect(handle);
    initialized=false; subscribed=false; send_requested=false;
}
static void stop_input(uint32_t id) {
    if(lg_profile) lg_end_motion(&magic);
    cancel_queued("Input stopped");
    if (!stop_pending) stop_time=now_ms();
    hid_stop(&input,id,now_ms()); stop_pending=true;
    if (sent_consumer) {
        input.queue[input.count-1].id=0;
        input.queue[input.count++]=(hid_report){ .id=id, .time=now_ms(), .consumer=true };
    }
    if (sent_key) {
        input.queue[input.count-1].id=0;
        input.queue[input.count++]=(hid_report){ .id=id, .time=now_ms(), .keyboard=true };
    }
    if (!available()) {
        if ((sent_buttons || sent_consumer || sent_key) && handle!=HCI_CON_HANDLE_INVALID) {
            error_text="Release unavailable; Bluetooth disconnected";
            disconnect_host(); reply(id,error_text);
        } else { hid_reset(&input); stop_pending=false; reply(id,NULL); }
    } else pump();
}
static void close_client(void) {
    if (client < 0) return;
    int fd=client; client=-1;
    btstack_run_loop_remove_data_source(&client_ds); close(fd);
    input_used=output_used=0; highest_id=0;
    stop_input(0);
}
static void accepted_report(const hid_report *report) {
    bool state_changed=!initialized || sent_buttons!=report->buttons;
    uint32_t id=report->id;
    if (report->consumer) { sent_consumer=report->usage; consumer_sent_at=now_ms(); }
    else if (report->keyboard) { sent_key=report->usage; key_sent_at=now_ms(); }
    else sent_buttons=report->buttons;
    reports_sent++;
    hid_pop(&input);
    if (!input.active && !sent_buttons && !sent_consumer && !sent_key && input.count==0) { initialized=true; stop_pending=false; }
    reply(id,NULL);
    if(state_changed) send_status();
    if(initialized) {
        if(switching_host && switching_host==connected_host() && encrypted()) {
            printf("SWITCH ready peer=%08x elapsed_ms=%u\n",switching_host,(uint32_t)(now_ms()-switch_started));
            switching_host=0;
        }
        query_host_name();
    }
}
static void send_one(void) {
    send_requested=false;
    if (control_ready()) {
        int result=hids_device_send_input_report_for_id(handle,LG_CONTROL_REPORT,control_queue[control_head].bytes,control_queue[control_head].length);
        if (result==ERROR_CODE_SUCCESS) { control_head=(control_head+1)%8; control_count--; reports_sent++; }
        else { control_count=0; error_text="LG control response rejected"; disconnect_host(); }
        return;
    }
    if (!available()) return;
    const hid_report *report=hid_peek(&input,now_ms());
    bool startup=lg_profile && magic.start_pending && input.active && report && report->motion && magic.motion_requested;
    if(lg_profile && (magic.stop_pending || startup)) {
        bool stopping=magic.stop_pending;
        int16_t axes[6]; memcpy(axes,startup && !stopping?report->axes:last_axes,sizeof(axes));
        axes[0]=axes[1]=axes[2]=0;
        uint8_t remote_data[LG_MOTION_SIZE];
        lg_encode(remote_data,0xc4,stopping?magic.sequence:0,remote_battery,false,axes,
                  stopping?LG_MOTION_STOP:LG_MOTION_START,0);
        int result;
        if(simulation) {
            printf("TEST_LG"); for(unsigned i=0;i<sizeof(remote_data);i++) printf(" %02x",remote_data[i]); puts(""); result=0;
        } else result=hids_device_send_input_report_for_id(handle,LG_MOTION_REPORT,remote_data,sizeof(remote_data));
        if(result==ERROR_CODE_SUCCESS) {
            if(stopping) { magic.stop_pending=false; magic.motion_running=false; }
            else { magic.start_pending=false; magic.motion_running=true; magic.sequence=0; }
            reports_sent++;
        } else {
            error_text="LG motion transition rejected"; cancel_queued(error_text);
            hid_reset(&input); stop_pending=false; disconnect_host(); send_status();
        }
        return;
    }
    if (!report) return;
    uint8_t data[6]; hid_encode(report,data);
    int result;
    if (lg_profile) {
        bool pointing=input.active && magic.motion_requested && !magic.start_pending;
        int16_t axes[6]; memcpy(axes,report->motion?report->axes:last_axes,sizeof(axes));
        if (!report->motion || !input.active) axes[0]=axes[1]=axes[2]=0;
        uint16_t key=report->keyboard && report->usage ? report->usage : report->buttons&1 ? 0x8044 : report->buttons&2 ? 0x8028 : 0;
        uint8_t remote_data[LG_MOTION_SIZE];
        uint8_t sequence=pointing && report->motion ? lg_motion_sequence(&magic) : magic.sequence;
        lg_encode(remote_data,0xc4,sequence,remote_battery,pointing,axes,key,(int8_t)report->wheel);
        if (simulation) {
            printf("TEST_LG"); for(unsigned i=0;i<sizeof(remote_data);i++) printf(" %02x",remote_data[i]); puts(""); result=0;
        } else result=hids_device_send_input_report_for_id(handle,LG_MOTION_REPORT,remote_data,sizeof(remote_data));
    } else if (report->consumer) {
        uint8_t consumer_data[]={(uint8_t)report->usage,(uint8_t)(report->usage>>8)};
        if (simulation) { printf("TEST_MEDIA %u\n",report->usage); fflush(stdout); result=0; }
        else if (!consumer_subscribed || protocol_mode==0) result=ERROR_CODE_COMMAND_DISALLOWED;
        else result=hids_device_send_input_report_for_id(handle,2,consumer_data,sizeof(consumer_data));
    } else if (report->keyboard) {
        uint8_t key_data=(uint8_t)report->usage;
        if (simulation) { printf("TEST_KEY %u\n",report->usage); fflush(stdout); result=0; }
        else if (!keyboard_subscribed || protocol_mode==0) result=ERROR_CODE_COMMAND_DISALLOWED;
        else result=hids_device_send_input_report_for_id(handle,3,&key_data,sizeof(key_data));
    } else if (simulation) {
        printf("TEST_REPORT %u %"PRId32" %"PRId32" %"PRId32"\n",report->buttons,report->dx,report->dy,report->wheel); fflush(stdout); result=0;
    } else if (protocol_mode==0) {
        int dx=report->dx>127?127:report->dx < -127?-127:report->dx;
        int dy=report->dy>127?127:report->dy < -127?-127:report->dy;
        uint8_t boot[]={report->buttons,(uint8_t)dx,(uint8_t)dy};
        result=hids_device_send_boot_mouse_input_report(handle,boot,sizeof(boot));
    } else result=hids_device_send_input_report_for_id(handle,1,data,sizeof(data));
    if (result==ERROR_CODE_SUCCESS) accepted_report(report);
    else {
        error_text="Bluetooth report rejected"; cancel_queued(error_text);
        hid_reset(&input); stop_pending=false; disconnect_host(); send_status();
    }
}
static void pump(void) {
    if (send_requested || (!control_ready() && (!available() || (!(lg_profile && magic.stop_pending) && !hid_peek(&input,now_ms()))))) return;
    if (simulation) {
        if (simulation_interval && (uint32_t)(now_ms()-simulation_last)<simulation_interval) return;
        do { simulation_last=now_ms(); send_one(); } while(!simulation_interval && available() && ((lg_profile && magic.stop_pending) || hid_peek(&input,now_ms())));
        return;
    }
    send_requested=true;
    if (hids_device_request_can_send_now_event(handle)!=ERROR_CODE_SUCCESS) send_requested=false;
}
static bool number(const char *text, int64_t min, int64_t max, int64_t *value) {
    if (!text || !*text) return false;
    char *end; errno=0; long long n=strtoll(text,&end,10);
    if(errno || *end || n<min || n>max) return false;
    *value=n; return true;
}
static void sync_bonds(void) {
    if(tlv_context.file && (fflush(tlv_context.file) || ferror(tlv_context.file) || fsync(fileno(tlv_context.file)))) fatal("Saving Bluetooth bonds");
}
static void selected_changed(void) {
    const host_record *selected=hosts_by_id(&hosts,hosts.selected_id);
    trust_index=selected?selected->db_slot:-1;
}
static bool lg_host(const host_record *host) {
    if (!host) return false;
    const char *name=host->bluetooth_name[0]?host->bluetooth_name:host->custom_name;
    return (!strncasecmp(name,"LG ",3) || !strncasecmp(name,"[LG]",4)) && (strcasestr(name,"TV") || strcasestr(name,"OLED"));
}
static void configure_profile(void) {
    if (handle!=HCI_CON_HANDLE_INVALID) return;
    lg_profile=pairing()?lg_pairing:lg_host(hosts_by_id(&hosts,hosts.selected_id));
    magic=(lg_remote){0}; control_subscribed=false; control_head=control_count=0;
    memset(last_axes,0,sizeof(last_axes)); last_axes[5]=-4096;
    if (simulation) { magic.motion_requested=true; return; }
    att_set_db(lg_profile?lg_gatt_database():profile_data);
    if(tlv) {
        int migrated=migrate_gatt_subscriptions(tlv,&tlv_context,lg_profile);
        if(migrated<0) { errno=EIO; fatal("Preserving Bluetooth profile subscriptions"); }
        if(migrated) sync_bonds();
    }
    if (lg_profile) hids_device_init_with_storage(0,lg_descriptor,sizeof(lg_descriptor),LG_GATT_REPORT_COUNT,lg_report_storage);
    else hids_device_init(0,descriptor,sizeof(descriptor));
    gap_advertisements_set_data(lg_profile?sizeof(lg_advertising):sizeof(advertising),lg_profile?lg_advertising:advertising);
    gap_scan_response_set_data(lg_profile?sizeof(lg_scan_response):0,lg_scan_response);
}
static void advertise(void) {
    if(simulation || !working || probe || shutting_down || handle!=HCI_CON_HANDLE_INVALID) return;
    bd_addr_t direct={0};
    gap_advertisements_enable(0);
    configure_profile();
    gap_whitelist_clear();
    const host_record *selected=hosts_by_id(&hosts,hosts.selected_id);
    bool filtered=selected && !pairing() && privacy_filter;
    if(filtered && gap_whitelist_add((bd_addr_type_t)selected->address_type,selected->address)!=ERROR_CODE_SUCCESS) {
        error_text="Bluetooth connection filter unavailable"; return;
    }
    gap_advertisements_set_params(fast_advertising?0x20:0x30,fast_advertising?0x20:0x60,0,0,direct,7,filtered?2:0);
    gap_advertisements_enable(selected!=NULL || pairing());
}
static void reconnect_advertising(void) {
    advertising_started=now_ms(); fast_advertising=true; advertise();
}
static bool peer_id(const char *text,uint32_t *value) {
    if(strlen(text)!=8) return false;
    uint32_t id=0;
    for(unsigned i=0;i<8;i++) {
        unsigned char c=(unsigned char)text[i];
        if(!((c>='0' && c<='9') || (c>='a' && c<='f'))) return false;
        id=(id<<4)|(uint32_t)(c<='9'?c-'0':c-'a'+10);
    }
    *value=id; return id!=0;
}
static bool name_from_hex(const char *text,char *name) {
    if(!strcmp(text,"-")) { name[0]=0; return true; }
    size_t size=strlen(text);
    if(!size || size>HOSTS_NAME_BYTES*2 || size%2) return false;
    for(size_t i=0;i<size;i+=2) {
        unsigned value=0;
        for(unsigned j=0;j<2;j++) {
            unsigned char c=(unsigned char)text[i+j];
            if(!((c>='0' && c<='9') || (c>='a' && c<='f'))) return false;
            value=(value<<4)|(unsigned)(c<='9'?c-'0':c-'a'+10);
        }
        name[i/2]=(char)value;
    }
    name[size/2]=0; return hosts_valid_text(name,size/2);
}
static void simulate_reconnect(void) {
    if(!simulation) return;
    configure_profile();
    subscribed=report_subscribed=hosts.selected_id!=0 && !pairing();
    initialized=subscribed; name_attempted=false;
}
static bool management(char **tokens,unsigned count,uint32_t id) {
    bool select=!strcmp(tokens[0],"SELECT"),forget=!strcmp(tokens[0],"FORGET");
    bool rename=!strcmp(tokens[0],"RENAME"),reorder=!strcmp(tokens[0],"REORDER");
    bool begin=!strcmp(tokens[0],"PAIR") || !strcmp(tokens[0],"PAIR_LG"),cancel=!strcmp(tokens[0],"CANCEL_PAIR");
    bool disconnect=!strcmp(tokens[0],"DISCONNECT"),reconnect=!strcmp(tokens[0],"RECONNECT");
    if(!select && !forget && !rename && !reorder && !begin && !cancel && !disconnect && !reconnect) return false;
    if(reconnect) {
        /* A peripheral cannot dial a host; it can only advertise and wait. RECONNECT restarts the fast
         * 20 ms window for the selected host. It is harmless while connected or pairing, so it never fails. */
        if(count!=2) { close_client(); return true; }
        if(!working || shutting_down) reply(id,"Bluetooth is not ready");
        else if(!hosts.selected_id) reply(id,"No computer is selected");
        else { if(handle==HCI_CON_HANDLE_INVALID && !pairing()) reconnect_advertising(); reply(id,NULL); }
        send_status(); return true;
    }
    if(input.active || input.count || sent_consumer || sent_key || stop_pending || shutting_down || !working) { reply(id,"Pause pointing before managing computers"); return true; }
    if(pairing() && !cancel) { reply(id,"Finish or cancel pairing first"); return true; }
    if((begin || cancel || disconnect) && count!=2) { close_client(); return true; }
    if(disconnect) {
        if(hosts_select(&hosts,0)) fatal("Disconnecting computer");
        switching_host=0; selected_changed(); disconnect_host(); simulate_reconnect(); reconnect_advertising(); reply(id,NULL);
    } else if(begin) {
        if(!hosts.next_id || hosts.count==HOSTS_LIMIT || (!simulation && le_device_db_count()>=HOSTS_LIMIT)) reply(id,"Four computers are already paired");
        else { lg_pairing=!strcmp(tokens[0],"PAIR_LG"); pairing_until=now_ms()+60000; disconnect_host(); simulate_reconnect(); reconnect_advertising(); reply(id,NULL); }
    } else if(cancel) {
        if(!pairing_until) { reply(id,NULL); send_status(); return true; }
        pairing_until=0; disconnect_host(); simulate_reconnect(); reconnect_advertising(); reply(id,NULL);
    } else if(reorder) {
        if(count!=3) { close_client(); return true; }
        uint32_t ids[HOSTS_LIMIT]; size_t n=0; char *save=NULL;
        if(tokens[2][0]==',' || tokens[2][strlen(tokens[2])-1]==',' || strstr(tokens[2],",,")) { reply(id,"Invalid computer order"); return true; }
        if(strcmp(tokens[2],"-")) {
            for(char *part=strtok_r(tokens[2],",",&save);part;part=strtok_r(NULL,",",&save)) {
                if(n==HOSTS_LIMIT || !peer_id(part,&ids[n])) { reply(id,"Invalid computer order"); return true; }
                n++;
            }
        }
        if(hosts_reorder(&hosts,ids,n)) {
            if(errno==EINVAL || errno==ENOENT) reply(id,"Computer list changed; try again"); else fatal("Saving computer order");
        } else reply(id,NULL);
    } else {
        uint32_t peer;
        if(count!=(rename?4u:3u)) { close_client(); return true; }
        if(!peer_id(tokens[2],&peer)) { reply(id,"Invalid computer ID"); return true; }
        const host_record *found=hosts_by_id(&hosts,peer);
        if(!found) { reply(id,"Computer is no longer paired"); return true; }
        if(rename) {
            char name[HOSTS_NAME_BYTES+1];
            if(!name_from_hex(tokens[3],name)) reply(id,"Name must be valid text within 48 UTF-8 bytes");
            else if(hosts_rename(&hosts,peer,name)) fatal("Saving computer name");
            else reply(id,NULL);
        } else if(select) {
            if(hosts.selected_id!=peer) {
                if(hosts_select(&hosts,peer)) fatal("Selecting computer");
                switch_started=now_ms(); switching_host=peer;
                printf("SWITCH requested peer=%08x\n",peer);
                selected_changed(); disconnect_host(); simulate_reconnect(); reconnect_advertising();
            }
            reply(id,NULL);
        } else {
            host_record removed=*found;
            bool was_selected=peer==hosts.selected_id;
            if(hosts_forget(&hosts,peer)) fatal("Forgetting computer");
            selected_changed();
            if(was_selected) { disconnect_host(); simulate_reconnect(); }
            if(!simulation) { gap_delete_bonding((bd_addr_type_t)removed.address_type,removed.address); sync_bonds(); }
            reconnect_advertising(); reply(id,NULL);
        }
    }
    send_status(); return true;
}
static void command(char *line) {
    char *tokens[9], *save=NULL; unsigned count=0;
    for(char *token=strtok_r(line," \r",&save); token && count<9; token=strtok_r(NULL," \r",&save)) tokens[count++]=token;
    int64_t id=0,a=0,b=0;
    if(count<2 || count==9 || !number(tokens[1],0,UINT32_MAX,&id)) { close_client(); return; }
    bool ping=!strcmp(tokens[0],"PING"), imu=!strcmp(tokens[0],"IMU"), move=!strcmp(tokens[0],"MOVE");
    if ((ping || move || imu) ? id!=0 : id<=highest_id) { close_client(); return; }
    if (!ping && !move && !imu) highest_id=(uint32_t)id;
    last_seen=now_ms();
    if (ping && count==2) return;
    if(management(tokens,count,(uint32_t)id)) return;
    if (!strcmp(tokens[0],"STOP") && count==2) { stop_input((uint32_t)id); send_status(); return; }
    if (!strcmp(tokens[0],"OPEN") && count==2) {
        if (!ready() || input.active || !hid_open(&input)) reply((uint32_t)id,"Bluetooth host is not ready");
        else { if(lg_profile) lg_begin_motion(&magic); error_text=""; reply((uint32_t)id,NULL); }
    } else if (imu && count==8) {
        int16_t axes[6];
        for(unsigned i=0;i<6;i++) { if(!number(tokens[i+2],-32768,32767,&a)) { close_client(); return; } axes[i]=(int16_t)a; }
        if(lg_profile && ready() && input.active) {
            if(!magic.motion_requested && (abs(axes[0])>300 || abs(axes[2])>300)) lg_begin_motion(&magic);
            memcpy(last_axes,axes,sizeof(axes));
            (void)hid_imu(&input,axes,now_ms()); pump();
        }
        return;
    } else if (!strcmp(tokens[0],"LGKEY") && count==3 && number(tokens[2],0,65535,&a)) {
        if(!lg_profile || !ready()) reply(id,"LG TV profile is unavailable");
        else if(!lg_key_supported((uint16_t)a)) reply(id,"Unknown LG remote key");
        else if(!hid_remote_key(&input,id,(uint16_t)a,now_ms())) { reply(id,"LG key queue full"); stop_input(0); }
        else pump();
    } else if (!strcmp(tokens[0],"MEDIA") && count==3 && number(tokens[2],0,1023,&a)) {
        if (lg_profile) reply(id,"Use LG remote keys for this TV");
        else if (a!=0xcd && a!=0xb6 && a!=0xb5 && a!=0xb7 && a!=0xe2 && a!=0xe9 && a!=0xea) reply(id,"Unknown media key");
        else if (!ready() || (!simulation && (!consumer_subscribed || protocol_mode==0))) reply(id,"Media reports unavailable; reconnect or pair this computer again");
        else if (!hid_media(&input,id,(uint16_t)a,now_ms())) { reply(id,"Media queue full"); stop_input(0); }
        else pump();
    } else if (!strcmp(tokens[0],"KEY") && count==3 && number(tokens[2],0,255,&a)) {
        if (lg_profile) reply(id,"Use LG remote keys for this TV");
        else if (!hid_key_supported((uint8_t)a)) reply(id,"Unknown keyboard key");
        else if (!ready() || (!simulation && (!keyboard_subscribed || protocol_mode==0))) reply(id,"Keyboard reports unavailable; reconnect or pair this computer again");
        else if (!hid_key(&input,id,(uint8_t)a,now_ms())) { reply(id,"Keyboard queue full"); stop_input(0); }
        else pump();
    } else if (!strcmp(tokens[0],"BUTTON") && count==3 && number(tokens[2],0,3,&a)) {
        if (!ready() || !input.active) reply((uint32_t)id,"Pointer is off");
        else if (!hid_button(&input,(uint32_t)id,(uint8_t)a,now_ms())) {
            reply((uint32_t)id,"Button queue full"); error_text="Button queue overflow; pointing stopped"; stop_input(0);
        } else pump();
    } else if (move && count==4 && number(tokens[2],-32767,32767,&a) && number(tokens[3],-32767,32767,&b)) {
        /* Motion is best-effort: a full queue drops this movement and counts it in dropped_motion.
         * Only button, scroll, media and keyboard overflow stop pointing, because a lost edge needs recovery.
         * Movement also does not emit status; the 250 ms timer and state changes cover it. */
        if (!lg_profile && ready() && input.active) { (void)hid_move(&input,(int32_t)a,(int32_t)b,now_ms()); pump(); }
        return;
    } else if (!strcmp(tokens[0],"SCROLL") && count==3 && number(tokens[2],-127,127,&a)) {
        if (!ready() || !input.active) reply((uint32_t)id,"Pointer is off");
        else if (!hid_scroll(&input,(uint32_t)id,(int32_t)a,now_ms())) {
            reply((uint32_t)id,"Input queue full"); stop_input(0);
        } else pump();
    } else { close_client(); return; }
    send_status();
}
static void client_event(btstack_data_source_t *ds, btstack_data_source_callback_type_t type) {
    (void)ds;
    if(type==DATA_SOURCE_CALLBACK_WRITE) { flush_output(); return; }
    char chunk[512]; ssize_t size=recv(client,chunk,sizeof(chunk),0);
    if(size<=0) { if(size==0 || (errno!=EAGAIN && errno!=EWOULDBLOCK && errno!=EINTR)) close_client(); return; }
    for(ssize_t i=0;i<size && client>=0;i++) {
        if(chunk[i]=='\n') { input_buffer[input_used]=0; input_used=0; command(input_buffer); }
        else if(chunk[i]==0 || input_used==sizeof(input_buffer)-1) { close_client(); return; }
        else input_buffer[input_used++]=chunk[i];
    }
}
static void accept_client(btstack_data_source_t *ds, btstack_data_source_callback_type_t type) {
    (void)ds; (void)type;
    int fd=accept4(listener,NULL,NULL,SOCK_NONBLOCK|SOCK_CLOEXEC);
    if(fd<0) return;
    struct ucred credentials; socklen_t length=sizeof(credentials);
    if(client>=0 || getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&credentials,&length) || (credentials.uid!=client_uid && credentials.uid!=0)) { close(fd); return; }
    client=fd; highest_id=0; input_used=output_used=0; last_seen=now_ms();
    memset(&client_ds,0,sizeof(client_ds)); btstack_run_loop_set_data_source_fd(&client_ds,fd);
    btstack_run_loop_set_data_source_handler(&client_ds,client_event);
    btstack_run_loop_enable_data_source_callbacks(&client_ds,DATA_SOURCE_CALLBACK_READ);
    btstack_run_loop_add_data_source(&client_ds); send_status();
}
static void start_socket(void) {
    struct sockaddr_un address={.sun_family=AF_UNIX};
    if(strlen(socket_path)>=sizeof(address.sun_path)) { errno=ENAMETOOLONG; fatal("Socket path"); }
    strcpy(address.sun_path,socket_path);
    struct stat info;
    if(lstat(socket_path,&info)==0) {
        if(!S_ISSOCK(info.st_mode) || info.st_uid!=geteuid()) { errno=EEXIST; fatal("Socket path occupied"); }
        if(unlink(socket_path)) fatal("Old socket removal");
    } else if(errno!=ENOENT) fatal("Socket path inspection");
    listener=socket(AF_UNIX,SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0);
    if(listener<0 || bind(listener,(struct sockaddr*)&address,sizeof(address)) || chmod(socket_path,0660) || listen(listener,2)) fatal("Control socket");
    btstack_run_loop_set_data_source_fd(&listener_ds,listener);
    btstack_run_loop_set_data_source_handler(&listener_ds,accept_client);
    btstack_run_loop_enable_data_source_callbacks(&listener_ds,DATA_SOURCE_CALLBACK_READ);
    btstack_run_loop_add_data_source(&listener_ds);
}
static void notify_service(const char *message) {
    const char *path=getenv("NOTIFY_SOCKET"); if(!path || !*path) return;
    struct sockaddr_un address={.sun_family=AF_UNIX}; size_t size=strlen(path);
    if(size>=sizeof(address.sun_path)) return;
    memcpy(address.sun_path,path,size+1); if(path[0]=='@') address.sun_path[0]=0;
    int fd=socket(AF_UNIX,SOCK_DGRAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
    if(fd>=0) { (void)sendto(fd,message,strlen(message),MSG_NOSIGNAL,(struct sockaddr*)&address,offsetof(struct sockaddr_un,sun_path)+size+1); close(fd); }
}
static void shutdown_complete(void) {
    if(tlv) btstack_tlv_posix_deinit(&tlv_context);
    if(listener>=0) unlink(socket_path);
    exit(0);
}
static void shutdown_start(void) {
    if(shutting_down) return;
    shutting_down=true; pairing_until=0;
    if(!simulation && working) gap_advertisements_enable(0);
    stop_input(0);
}
static void signal_event(btstack_data_source_t *ds, btstack_data_source_callback_type_t type) {
    (void)type; struct signalfd_siginfo info;
    if(read(btstack_run_loop_get_data_source_fd(ds),&info,sizeof(info))==(ssize_t)sizeof(info)) shutdown_start();
}
static int battery_level(void) {
    FILE *file=fopen("/sys/class/power_supply/rk817-battery/capacity","r");
    if(!file) return -1;
    int level=-1;
    if(fscanf(file,"%d",&level)!=1 || level<0 || level>100) level=-1;
    fclose(file); return level;
}
static void name_finished(void) {
    name_phase=0;
    size_t length=name_received>HOSTS_NAME_BYTES?HOSTS_NAME_BYTES:name_received;
    if(name_clipped && length) {
        size_t start=length-1;
        while(start && ((uint8_t)name_value[start]&0xc0)==0x80) start--;
        uint8_t lead=(uint8_t)name_value[start];
        unsigned needed=lead>=0xc2 && lead<=0xdf?2:lead>=0xe0 && lead<=0xef?3:lead>=0xf0 && lead<=0xf4?4:1;
        if(needed>length-start) length=start;
    }
    if(!hosts_valid_text(name_value,length)) { name_phase=0; return; }
    name_value[length]=0;
    if(length && encrypted() && hosts.selected_id==name_host && connected_host()==name_host && handle==name_connection) {
        memcpy(pending_name,name_value,length+1); pending_name_host=name_host;
    }
}
static void name_event(uint8_t type,uint16_t channel,uint8_t *packet,uint16_t size) {
    (void)channel;
    if(type!=HCI_EVENT_PACKET || size<4 || !name_phase || handle!=name_connection || little_endian_read_16(packet,2)!=name_connection || hosts.selected_id!=name_host || !encrypted() || connected_host()!=name_host) return;
    switch(hci_event_packet_get_type(packet)) {
    case GATT_EVENT_CHARACTERISTIC_VALUE_QUERY_RESULT: {
        if(size<12 || name_phase!=1 || name_value_handle) break;
        uint16_t length=gatt_event_characteristic_value_query_result_get_value_length(packet);
        if((unsigned)length+12>size) break;
        name_value_handle=gatt_event_characteristic_value_query_result_get_value_handle(packet);
        size_t copied=length>HOSTS_NAME_BYTES?HOSTS_NAME_BYTES:length;
        memcpy(name_value,gatt_event_characteristic_value_query_result_get_value(packet),copied); name_value[copied]=0; name_clipped=length>HOSTS_NAME_BYTES;
        break;
    }
    case GATT_EVENT_LONG_CHARACTERISTIC_VALUE_QUERY_RESULT: {
        if(size<14 || name_phase!=2 || gatt_event_long_characteristic_value_query_result_get_value_handle(packet)!=name_value_handle) break;
        uint16_t offset=gatt_event_long_characteristic_value_query_result_get_value_offset(packet);
        uint16_t length=gatt_event_long_characteristic_value_query_result_get_value_length(packet);
        if((unsigned)length+14>size || offset!=name_received) { name_phase=0; break; }
        if(offset<HOSTS_NAME_BYTES) {
            size_t copied=length;
            if(copied>(size_t)(HOSTS_NAME_BYTES-offset)) copied=HOSTS_NAME_BYTES-offset;
            memcpy(name_value+offset,gatt_event_long_characteristic_value_query_result_get_value(packet),copied);
            name_value[offset+copied]=0;
        }
        name_received=(uint16_t)(offset+length); name_clipped=name_received>HOSTS_NAME_BYTES;
        break;
    }
    case GATT_EVENT_QUERY_COMPLETE:
        if(size<9 || gatt_event_query_complete_get_att_status(packet)!=ATT_ERROR_SUCCESS) { name_phase=0; break; }
        if(name_phase==1 && name_value_handle) {
            name_phase=2; name_received=0;
            if(gatt_client_read_long_value_of_characteristic_using_value_handle(name_event,handle,name_value_handle)!=ERROR_CODE_SUCCESS) name_phase=0;
        } else name_finished();
        break;
    default: break;
    }
}
static void query_host_name(void) {
    if(simulation || probe || name_attempted || !encrypted()) return;
    name_attempted=true; name_host=hosts.selected_id; name_connection=handle;
    name_phase=1; name_value_handle=0; name_received=0; name_value[0]=0; name_clipped=false;
    if(gatt_client_read_value_of_characteristics_by_uuid16(name_event,handle,1,0xffff,0x2a00)!=ERROR_CODE_SUCCESS) name_phase=0;
}
static void tick_event(btstack_timer_source_t *timer) {
    uint32_t now=now_ms(); notify_service("WATCHDOG=1");
    if(sent_consumer && !stop_pending && (uint32_t)(now-consumer_sent_at)>=RELEASE_MS) stop_input(0);
    if(sent_key && !stop_pending && (uint32_t)(now-key_sent_at)>=RELEASE_MS) stop_input(0);
    if(fast_advertising && (uint32_t)(now-advertising_started)>=30000) { fast_advertising=false; advertise(); }
    if(switching_host && (uint32_t)(now-switch_started)>=30000) switching_host=0;
    if(pending_name_host && !input.active && !stop_pending) {
        const host_record *host=hosts_by_id(&hosts,pending_name_host);
        if(host && strcmp(host->bluetooth_name,pending_name) && hosts_set_bluetooth_name(&hosts,pending_name_host,pending_name)) fatal("Saving Bluetooth name");
        pending_name_host=0;
    }
    if(!simulation && !probe && (uint32_t)(now-last_battery)>=60000) {
        last_battery=now; int level=battery_level();
        if(level>=0) { remote_battery=(uint8_t)((level*63+50)/100); battery_service_server_set_battery_value((uint8_t)level); }
    }
    if(!working && (uint32_t)(now-started_at)>15000) { errno=ETIMEDOUT; fatal("Bluetooth initialization"); }
    if(client>=0 && (uint32_t)(now-last_seen)>=LEASE_MS) close_client();
    if(pairing_until && !pairing()) { pairing_until=0; disconnect_host(); simulate_reconnect(); reconnect_advertising(); send_status(); }
    if(!simulation && handle!=HCI_CON_HANDLE_INVALID && !encrypted() && (uint32_t)(now-connected_at)>10000 && !pairing()) disconnect_host();
    if(stop_pending && (uint32_t)(now-stop_time)>=RELEASE_MS) {
        error_text="Release delivery timed out; Bluetooth disconnected";
        cancel_queued(error_text); hid_reset(&input); stop_pending=false; disconnect_host();
    }
    if(shutting_down && !stop_pending) {
        if(simulation) shutdown_complete();
        if(!powering_off) { powering_off=true; hci_power_control(HCI_POWER_OFF); }
    } else pump();
    if((uint32_t)(now-last_status)>=250) { last_status=now; send_status(); }
    btstack_run_loop_set_timer(timer,50); btstack_run_loop_add_timer(timer);
}
static void establish_ready(void) {
    if(!available() || initialized || stop_pending) return;
    if(!switching_host) { printf("LINK ready peer=%08x\n",connected_host()); fflush(stdout); }
    hid_stop(&input,0,now_ms()); stop_pending=true; stop_time=now_ms(); pump();
}
static void report_snapshot(hci_con_handle_t connection,hid_report_type_t type,uint16_t id,uint16_t size,uint8_t *out) {
    (void)connection; (void)type;
    if (lg_profile) {
        memset(out,0,size);
        if(id==LG_MOTION_REPORT) {
            uint8_t data[LG_MOTION_SIZE]; int16_t axes[6]; memcpy(axes,last_axes,sizeof(axes)); axes[0]=axes[1]=axes[2]=0;
            lg_encode(data,0xc4,magic.sequence,remote_battery,false,axes,sent_key?sent_key:sent_buttons&1?0x8044:sent_buttons&2?0x8028:0,0);
            memcpy(out,data,size<sizeof(data)?size:sizeof(data));
        }
        return;
    }
    if (id==2) { memset(out,0,size); if(size) out[0]=(uint8_t)sent_consumer; if(size>1) out[1]=(uint8_t)(sent_consumer>>8); return; }
    if (id==3) { memset(out,0,size); if(size) out[0]=sent_key; return; }
    size=size<6?size:6; memset(out,0,size); if(size) out[0]=sent_buttons;
}
static void radio_event(uint8_t type,uint16_t channel,uint8_t *packet,uint16_t size) {
    (void)channel;
    if(type!=HCI_EVENT_PACKET || size<2) return;
    switch(hci_event_packet_get_type(packet)) {
    case BTSTACK_EVENT_POWERON_FAILED: errno=EIO; fatal("Bluetooth power on"); break;
    case BTSTACK_EVENT_STATE:
        if(btstack_event_state_get_state(packet)==HCI_STATE_WORKING) {
            working=true;
            if(!probe) privacy_filter=gap_load_resolving_list_from_le_device_db()==ERROR_CODE_SUCCESS;
            if(probe) { puts("BCM4373A0 H4 controller initialized; no advertising or HID reports\nPROBE_OK"); fflush(stdout); shutdown_start(); }
            else { notify_service("READY=1"); reconnect_advertising(); }
        } else if(btstack_event_state_get_state(packet)==HCI_STATE_OFF && shutting_down) shutdown_complete();
        break;
    case HCI_EVENT_COMMAND_COMPLETE:
        if(hci_event_command_complete_get_command_opcode(packet)==HCI_OPCODE_HCI_READ_LOCAL_VERSION_INFORMATION && size>=14) {
            if(little_endian_read_16(packet,10)!=15 || little_endian_read_16(packet,12)!=0x2119) { errno=ENODEV; fatal("Unverified Bluetooth controller"); }
        }
        break;
    case HCI_EVENT_META_GAP:
        if(hci_event_gap_meta_get_subevent_code(packet)==GAP_SUBEVENT_LE_CONNECTION_COMPLETE && !gap_subevent_le_connection_complete_get_status(packet)) {
            handle=gap_subevent_le_connection_complete_get_connection_handle(packet);
            connected_at=now_ms();
            if(switching_host) printf("SWITCH link peer=%08x elapsed_ms=%u\n",switching_host,(uint32_t)(connected_at-switch_started));
            else printf("LINK connected interval_units=%u advertising_ms=%u\n",gap_subevent_le_connection_complete_get_conn_interval(packet),(uint32_t)(connected_at-advertising_started));
            fflush(stdout);
            initialized=false; subscribed=report_subscribed=boot_subscribed=consumer_subscribed=keyboard_subscribed=false; sent_consumer=0; sent_key=0; protocol_mode=1; sent_buttons=0; hid_reset(&input);
            name_attempted=false; name_phase=0; name_connection=HCI_CON_HANDLE_INVALID;
            interval_units=gap_subevent_le_connection_complete_get_conn_interval(packet);
            if(!hosts.selected_id && !pairing()) disconnect_host();
            else { sm_request_pairing(handle); gap_request_connection_parameter_update(handle,6,6,0,400); }
        }
        break;
    case HCI_EVENT_DISCONNECTION_COMPLETE:
        if(hci_event_disconnection_complete_get_connection_handle(packet)==handle) {
            handle=HCI_CON_HANDLE_INVALID; subscribed=report_subscribed=boot_subscribed=consumer_subscribed=keyboard_subscribed=false; sent_consumer=0; sent_key=0; protocol_mode=1; initialized=false; send_requested=false; stop_pending=false; sent_buttons=0;
            name_phase=0; name_connection=HCI_CON_HANDLE_INVALID; name_attempted=false;
            cancel_queued("Bluetooth disconnected"); hid_reset(&input);
            control_subscribed=false; control_count=0;
            printf("LINK disconnected reason=0x%02x\n",hci_event_disconnection_complete_get_reason(packet)); fflush(stdout);
            reconnect_advertising(); send_status();
        }
        break;
    case HCI_EVENT_LE_META:
        if(hci_event_le_meta_get_subevent_code(packet)==HCI_SUBEVENT_LE_CONNECTION_UPDATE_COMPLETE && !hci_subevent_le_connection_update_complete_get_status(packet))
            interval_units=hci_subevent_le_connection_update_complete_get_conn_interval(packet);
        break;
    case SM_EVENT_JUST_WORKS_REQUEST:
        if(sm_event_just_works_request_get_handle(packet)!=handle) break;
        if(pairing() && hosts.count<HOSTS_LIMIT && !hosts_by_slot(&hosts,(uint8_t)sm_le_device_index(handle))) sm_just_works_confirm(sm_event_just_works_request_get_handle(packet));
        else sm_bonding_decline(sm_event_just_works_request_get_handle(packet));
        break;
    case SM_EVENT_NUMERIC_COMPARISON_REQUEST:
        if(sm_event_numeric_comparison_request_get_handle(packet)!=handle) break;
        sm_bonding_decline(sm_event_numeric_comparison_request_get_handle(packet));
        break;
    case SM_EVENT_IDENTITY_RESOLVING_SUCCEEDED: {
        if(sm_event_identity_resolving_succeeded_get_handle(packet)!=handle) break;
        uint16_t slot=sm_event_identity_resolving_succeeded_get_index(packet);
        const host_record *host=slot<HOSTS_LIMIT?hosts_by_slot(&hosts,(uint8_t)slot):NULL;
        if(host && (pairing() || host->id!=hosts.selected_id)) disconnect_host();
        break;
    }
    case SM_EVENT_PAIRING_COMPLETE: {
        if(sm_event_pairing_complete_get_handle(packet)!=handle) break;
        if(sm_event_pairing_complete_get_status(packet)!=0) { disconnect_host(); send_status(); break; }
        int slot=sm_le_device_index(handle);
        if(slot<0 || slot>=HOSTS_LIMIT) { disconnect_host(); break; }
        const host_record *known=hosts_by_slot(&hosts,(uint8_t)slot);
        if(!known) {
            if(!pairing() || hosts.count>=HOSTS_LIMIT || !hosts.next_id) {
                disconnect_host(); le_device_db_remove(slot); sync_bonds(); break;
            }
            int address_type; bd_addr_t address;
            le_device_db_info(slot,&address_type,address,NULL);
            if(address_type!=BD_ADDR_TYPE_LE_PUBLIC && address_type!=BD_ADDR_TYPE_LE_RANDOM) { disconnect_host(); break; }
            sync_bonds();
            uint32_t added;
            if(hosts_add(&hosts,(uint8_t)slot,(uint8_t)address_type,address,false,&added)) fatal("Saving paired computer");
            if(lg_pairing && hosts_set_bluetooth_name(&hosts,added,"LG TV")) fatal("Saving LG TV profile");
            pairing_until=0; selected_changed();
        } else if(pairing() || known->id!=hosts.selected_id) { disconnect_host(); break; }
        establish_ready(); send_status(); break;
    }
    case SM_EVENT_REENCRYPTION_COMPLETE:
    case HCI_EVENT_ENCRYPTION_CHANGE:
    case HCI_EVENT_ENCRYPTION_CHANGE_V2:
        if(hci_event_packet_get_type(packet)==SM_EVENT_REENCRYPTION_COMPLETE && sm_event_reencryption_complete_get_handle(packet)!=handle) break;
        if(hci_event_packet_get_type(packet)==HCI_EVENT_ENCRYPTION_CHANGE && hci_event_encryption_change_get_connection_handle(packet)!=handle) break;
        if(hci_event_packet_get_type(packet)==HCI_EVENT_ENCRYPTION_CHANGE_V2 && hci_event_encryption_change_v2_get_connection_handle(packet)!=handle) break;
        if(connected_host() && (pairing() || connected_host()!=hosts.selected_id)) { disconnect_host(); send_status(); break; }
        if (!encrypted() && (input.active || sent_buttons || sent_consumer || sent_key || stop_pending)) { initialized=false; stop_input(0); }
        else establish_ready();
        send_status(); break;
    case HCI_EVENT_HIDS_META:
        switch(hci_event_hids_meta_get_subevent_code(packet)) {
        case HIDS_SUBEVENT_SET_REPORT: {
            if(size<8 || !lg_profile || !encrypted() || hids_subevent_set_report_get_con_handle(packet)!=handle || hids_subevent_set_report_get_report_id(packet)!=LG_COMMAND_REPORT || hids_subevent_set_report_get_report_type(packet)!=HID_REPORT_TYPE_OUTPUT) break;
            unsigned length=hids_subevent_set_report_get_report_length(packet);
            if(length+8u>size) break;
            uint8_t response[30]; size_t response_length=lg_command(&magic,hids_subevent_set_report_get_report_data(packet),length,response);
            if(response_length) {
                if(control_count==8) { error_text="LG control queue full"; disconnect_host(); break; }
                unsigned tail=(control_head+control_count++)%8;
                memcpy(control_queue[tail].bytes,response,response_length); control_queue[tail].length=(uint8_t)response_length;
            }
            pump(); break;
        }
        case HIDS_SUBEVENT_INPUT_REPORT_ENABLE:
            if(lg_profile) {
                uint8_t id=hids_subevent_input_report_enable_get_report_id(packet);
                bool enabled=hids_subevent_input_report_enable_get_enable(packet)!=0;
                if(id==LG_CONTROL_REPORT) { control_subscribed=enabled; pump(); break; }
                if(id!=LG_MOTION_REPORT) break;
                subscribed=report_subscribed=enabled;
                if(!subscribed) { initialized=false; stop_input(0); } else establish_ready();
                send_status(); break;
            }
            if (hids_subevent_input_report_enable_get_report_id(packet)==3) {
                keyboard_subscribed=hids_subevent_input_report_enable_get_enable(packet)!=0;
                if (!keyboard_subscribed && sent_key) { stop_input(0); disconnect_host(); }
                break;
            }
            if (hids_subevent_input_report_enable_get_report_id(packet)==2) {
                consumer_subscribed=hids_subevent_input_report_enable_get_enable(packet)!=0;
                if (!consumer_subscribed && sent_consumer) { stop_input(0); disconnect_host(); }
                break;
            }
            report_subscribed=hids_subevent_input_report_enable_get_enable(packet)!=0;
            subscribed=protocol_mode ? report_subscribed : boot_subscribed;
            if(!subscribed) { initialized=false; stop_input(0); } else establish_ready();
            send_status(); break;
        case HIDS_SUBEVENT_BOOT_MOUSE_INPUT_REPORT_ENABLE:
            boot_subscribed=hids_subevent_boot_mouse_input_report_enable_get_enable(packet)!=0;
            subscribed=protocol_mode ? report_subscribed : boot_subscribed;
            if(!subscribed) { initialized=false; stop_input(0); } else establish_ready();
            send_status(); break;
        case HIDS_SUBEVENT_PROTOCOL_MODE:
            protocol_mode=hids_subevent_protocol_mode_get_protocol_mode(packet);
            subscribed=protocol_mode ? report_subscribed : boot_subscribed;
            initialized=false; stop_input(0); send_status(); break;
        case HIDS_SUBEVENT_CAN_SEND_NOW: send_one(); pump(); break;
        case HIDS_SUBEVENT_SUSPEND: stop_input(0); break;
        default: break;
        }
        break;
    default: break;
    }
}
static void load_identity(bd_addr_t address) {
    char path[PATH_MAX];
    if(snprintf(path,sizeof(path),"%s/identity",state_dir)>=(int)sizeof(path)) { errno=ENAMETOOLONG; fatal("State path"); }
    int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd<0 && errno==ENOENT) {
        if(getrandom(address,6,0)!=6) fatal("Bluetooth identity generation");
        address[0]|=0xc0;
        fd=open(path,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC|O_NOFOLLOW,0600);
        if(fd<0 || write(fd,address,6)!=6 || fsync(fd)) fatal("Saving Bluetooth identity");
        close(fd); return;
    }
    uint8_t data[7];
    if(fd<0 || read(fd,data,sizeof(data))!=6 || (data[0]&0xc0)!=0xc0) { errno=EINVAL; fatal("Bluetooth identity"); }
    memcpy(address,data,6); close(fd);
}
static uid_t local_airmouse_uid(void) {
    FILE *file=fopen("/etc/passwd","r");
    if(!file) fatal("Local accounts");
    char line[1024];
    while(fgets(line,sizeof(line),file)) {
        if(!strchr(line,'\n') && !feof(file)) { errno=EOVERFLOW; fatal("Local account line too long"); }
        if(strncmp(line,"airmouse:",9)) continue;
        char *password_end=strchr(line+9,':');
        char *uid_end=password_end?strchr(password_end+1,':'):NULL;
        int64_t uid;
        if(!uid_end) break;
        *uid_end=0;
        if(!number(password_end+1,1,UINT32_MAX-1,&uid)) break;
        fclose(file); return (uid_t)uid;
    }
    fclose(file); errno=ENOENT; fatal("Air mouse user missing"); return 0;
}
static void load_hosts(void) {
    char path[PATH_MAX];
    if(snprintf(path,sizeof(path),"%s/hosts.dat",state_dir)>=(int)sizeof(path)) { errno=ENAMETOOLONG; fatal("Computer registry path"); }
    int loaded=hosts_load(&hosts,path);
    if(loaded<0) fatal("Loading computers");
    if(!loaded) {
        if(simulation) {
            for(unsigned i=0;i<simulation_hosts;i++) {
                uint8_t address[6]={0xc0,0,0,0,0,(uint8_t)(i+1)}; uint32_t id;
                char name[40];
                if(i) snprintf(name,sizeof(name),"Simulated computer %u",i+1); else strcpy(name,simulation_lg?"[LG] webOS TV OLED77G3PSA":"Simulated computer");
                if(hosts_add(&hosts,(uint8_t)i,1,address,i==0,&id) || hosts_set_bluetooth_name(&hosts,id,name)) fatal("Simulated computer");
            }
            if(hosts.count && hosts_select(&hosts,hosts.records[0].id)) fatal("Selecting simulated computer");
        } else if(trust_index>=0) {
            int type; bd_addr_t address;
            le_device_db_info(trust_index,&type,address,NULL);
            if(type!=BD_ADDR_TYPE_LE_PUBLIC && type!=BD_ADDR_TYPE_LE_RANDOM) { errno=EINVAL; fatal("Legacy Bluetooth bond missing"); }
            uint32_t id;
            if(hosts_add(&hosts,(uint8_t)trust_index,(uint8_t)type,address,true,&id)) fatal("Migrating paired computer");
        } else if(le_device_db_count()) { errno=EINVAL; fatal("Unmanaged Bluetooth bonds"); }
        if(hosts_save(&hosts)) fatal("Saving computer registry");
    }
    if(!simulation) {
        for(unsigned i=0;i<hosts.count;i++) {
            const host_record *host=&hosts.records[i]; int type; bd_addr_t address;
            le_device_db_info(host->db_slot,&type,address,NULL);
            if(type!=host->address_type || memcmp(address,host->address,6)) { errno=EINVAL; fatal("Computer bond identity changed"); }
        }
        for(int slot=0;slot<HOSTS_LIMIT;slot++) {
            int type; le_device_db_info(slot,&type,NULL,NULL);
            if(type!=BD_ADDR_TYPE_UNKNOWN && !hosts_by_slot(&hosts,(uint8_t)slot)) le_device_db_remove(slot);
        }
        sync_bonds();
    }
    selected_changed();
}
int main(int argc,char **argv) {
    umask(0007); setvbuf(stdout,NULL,_IOLBF,0);
    for(int i=1;i<argc;i++) {
        if(!strcmp(argv[i],"--simulate")) simulation=true;
        else if(!strcmp(argv[i],"--simulate-lg")) simulation=simulation_lg=true;
        else if(!strcmp(argv[i],"--probe")) probe=true;
        else if(!strcmp(argv[i],"--simulate-hosts") && i+1<argc) {
            int64_t value; if(!number(argv[++i],0,HOSTS_LIMIT,&value)) return 2; simulation_hosts=(unsigned)value;
        }
        else if(!strcmp(argv[i],"--simulate-interval") && i+1<argc) {
            int64_t value; if(!number(argv[++i],0,200,&value)) return 2; simulation_interval=(uint32_t)value;
        }
        else if(!strcmp(argv[i],"--socket") && i+1<argc) socket_path=argv[++i];
        else if(!strcmp(argv[i],"--state-dir") && i+1<argc) state_dir=argv[++i];
        else if(!strcmp(argv[i],"--firmware") && i+1<argc) firmware_path=argv[++i];
        else { fprintf(stderr,"Usage: airmouse-hid [--socket PATH] [--state-dir PATH] [--firmware PATH] [--probe|--simulate]\n"); return 2; }
    }
    if((simulation && probe) || (simulation_interval && !simulation) || (simulation_hosts!=1 && !simulation)) return 2;
    client_uid=simulation?getuid():local_airmouse_uid();
    char path[PATH_MAX];
    if(snprintf(path,sizeof(path),"%s/owner.lock",state_dir)>=(int)sizeof(path)) return 2;
    int lock=open(path,O_RDWR|O_CREAT|O_CLOEXEC|O_NOFOLLOW,0600);
    if(lock<0 || flock(lock,LOCK_EX|LOCK_NB)) fatal("Bluetooth ownership lock");
    sigset_t signals; sigemptyset(&signals); sigaddset(&signals,SIGINT); sigaddset(&signals,SIGTERM);
    if(sigprocmask(SIG_BLOCK,&signals,NULL)) fatal("Signal mask");
    signal(SIGPIPE,SIG_IGN);
    btstack_memory_init(); btstack_run_loop_init(btstack_run_loop_posix_get_instance()); started_at=now_ms();
    int signal_fd=signalfd(-1,&signals,SFD_NONBLOCK|SFD_CLOEXEC);
    if(signal_fd<0) fatal("Signal descriptor");
    btstack_run_loop_set_data_source_fd(&signal_ds,signal_fd); btstack_run_loop_set_data_source_handler(&signal_ds,signal_event);
    btstack_run_loop_enable_data_source_callbacks(&signal_ds,DATA_SOURCE_CALLBACK_READ); btstack_run_loop_add_data_source(&signal_ds);
    hid_reset(&input); start_socket();
    btstack_run_loop_set_timer_handler(&tick,tick_event); btstack_run_loop_set_timer(&tick,50); btstack_run_loop_add_timer(&tick);
    if(simulation) { load_hosts(); working=true; simulate_reconnect(); interval_units=6; notify_service("READY=1"); }
    else {
        bd_addr_t address; load_identity(address);
        snprintf(path,sizeof(path),"%s/bonds.tlv",state_dir);
        tlv=btstack_tlv_posix_init_instance(&tlv_context,path); if(!tlv || !tlv_context.file) fatal("Bluetooth bond store");
        btstack_tlv_set_instance(tlv,&tlv_context); le_device_db_tlv_configure(tlv,&tlv_context);
        uint8_t stored; if(tlv->get_tag(&tlv_context,TRUST_TAG,&stored,1)==1 && stored<NVM_NUM_DEVICE_DB_ENTRIES) trust_index=stored;
        load_hosts();
        static hci_transport_config_uart_t config={.type=HCI_TRANSPORT_CONFIG_UART,.baudrate_init=115200,.baudrate_main=921600,.flowcontrol=BTSTACK_UART_FLOWCONTROL_ON,.parity=BTSTACK_UART_PARITY_OFF,.device_name="/dev/ttyS1"};
        hci_init(hci_transport_h4_instance_for_uart(btstack_uart_posix_instance()),&config);
        hci_set_chipset(btstack_chipset_bcm_instance()); btstack_chipset_bcm_set_hcd_file_path(firmware_path);
        l2cap_init(); sm_init(); gatt_client_init(); sm_set_io_capabilities(IO_CAPABILITY_NO_INPUT_NO_OUTPUT);
        sm_set_authentication_requirements(SM_AUTHREQ_SECURE_CONNECTION|SM_AUTHREQ_BONDING);
        sm_set_encryption_key_size_range(16,16); gap_random_address_set(address);
        att_server_init(profile_data,NULL,NULL);
        int level=battery_level();
        if(level<0) { errno=EIO; fatal("Reading battery level"); }
        battery_service_server_init((uint8_t)level); remote_battery=(uint8_t)((level*63+50)/100); last_battery=now_ms();
        configure_profile();
        hids_device_register_packet_handler(radio_event); hids_device_register_get_report_callback(report_snapshot);
        bd_addr_t direct={0}; gap_advertisements_set_params(0x30,0x60,0,0,direct,7,0);
        hci_events.callback=radio_event; hci_add_event_handler(&hci_events); sm_events.callback=radio_event; sm_add_event_handler(&sm_events);
        hci_power_control(HCI_POWER_ON);
    }
    btstack_run_loop_execute();
    return 0;
}
