#include "lg_remote.h"
#include <assert.h>
#include <string.h>

int main(void) {
    const uint8_t captured[]={0xc4,0x67,0xfe,0xff,0x00,0x42,0xff,0x4a,0xff,0x14,0xff,0xa5,0x01,0xd4,0xef,0x97,0x80,0x28,0x00};
    const int16_t axes[]={66,-182,-236,-91,468,-4201};
    uint8_t report[LG_MOTION_SIZE];
    lg_encode(report,0xc4,0x67,63,false,axes,0x8028,0);
    assert(!memcmp(report,captured,sizeof(captured)));
    lg_encode(report,200,255,100,true,axes,0x8044,-1);
    assert(report[1]==255 && report[2]==0xfd && report[18]==255);
    lg_remote remote={0}; uint8_t response[30];
    const uint8_t version[]={0x14,0x16,0x68,0x04,0x08,0x26,0x30,0x01,0x40,0x03,0x60,0x11};
    assert(lg_command(&remote,(uint8_t[]){0x13},1,response)==sizeof(version));
    assert(!memcmp(response,version,sizeof(version)));
    assert(lg_command(&remote,(uint8_t[]){0x19},1,response)==12);
    assert(response[0]==0x19 && response[1]==0x34 && response[2]==0x23 && response[11]==0xff);
    assert(lg_command(&remote,(uint8_t[]){0x90},1,response)==3);
    assert(!memcmp(response,(uint8_t[]){0x90,0,0},3));
    assert(!lg_command(&remote,(uint8_t[]){1},1,response) && remote.motion_requested);
    assert(!lg_command(&remote,(uint8_t[]){2},1,response) && !remote.motion_requested);
    assert(!lg_command(&remote,(uint8_t[]){1,0},2,response) && !remote.motion_requested);
    assert(!lg_command(&remote,(uint8_t[]){0xff},1,response));
    assert(lg_key_supported(0x8028) && lg_key_supported(0x8008) && !lg_key_supported(0));
    assert(lg_key_supported(0x7f01) && lg_key_supported(0x7f02));
    assert(lg_key_supported(0x7f03) && lg_key_supported(0x7f04));
    for (unsigned key=0x7f01; key<=0x7f0e; key++) assert(lg_key_supported(key));
    assert(!lg_key_supported(0x7f0f));
    lg_begin_motion(&remote);
    assert(remote.start_pending);
    remote.sequence=0;
    assert(lg_motion_sequence(&remote)==1);
    assert(lg_motion_sequence(&remote)==2);
    remote.sequence=254;
    assert(lg_motion_sequence(&remote)==255);
    assert(lg_motion_sequence(&remote)==0);
    assert(!lg_key_supported(LG_MOTION_START) && !lg_key_supported(LG_MOTION_STOP));
    return 0;
}
