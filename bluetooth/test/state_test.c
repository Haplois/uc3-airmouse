#include "hid_state.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
int main(void) {
    hid_state s; hid_reset(&s); assert(hid_open(&s));
    assert(hid_button(&s, 1, 1, 100));
    assert(hid_move(&s, 1000, -2000, 101));
    assert(hid_move(&s, 2, 3, 102));
    assert(hid_button(&s, 2, 0, 103));
    assert(hid_peek(&s, 104)->buttons == 1); assert(hid_peek(&s, 104)->id == 1); hid_pop(&s);
    const hid_report *r=hid_peek(&s,104); assert(r->buttons==1 && r->dx==1002 && r->dy==-1997);
    uint8_t bytes[6]; hid_encode(r,bytes); assert(bytes[0]==1 && bytes[1]==0xea && bytes[2]==3 && bytes[3]==0x33 && bytes[4]==0xf8);
    hid_pop(&s); assert(hid_peek(&s,104)->buttons==0 && hid_peek(&s,104)->id==2); hid_pop(&s);
    assert(hid_button(&s, 3, 3, 105)); assert(hid_scroll(&s,4,-1,106)); assert(hid_button(&s,5,2,107));
    assert(hid_peek(&s,108)->buttons==3); hid_pop(&s); assert(hid_peek(&s,108)->buttons==3 && hid_peek(&s,108)->wheel==-1); hid_pop(&s); assert(hid_peek(&s,108)->buttons==2);
    hid_stop(&s,6,110); assert(!s.active && s.count==1 && !s.buttons); assert(hid_peek(&s,111)->id==6 && hid_peek(&s,111)->buttons==0); assert(!hid_open(&s)); hid_pop(&s); assert(hid_open(&s));
    assert(hid_move(&s,10,10,200)); assert(hid_button(&s,7,1,201)); assert(hid_peek(&s,300)->id==7); assert(s.dropped==1); hid_pop(&s);
    for(unsigned i=0;i<HID_QUEUE_SIZE;i++) assert(hid_button(&s,i+10,i%2,301));
    assert(!hid_move(&s,1,1,301) && s.dropped==2);
    assert(!hid_button(&s,50,0,301)); hid_stop(&s,51,302); assert(s.count==1 && !s.buttons && !s.active);
    hid_reset(&s); assert(hid_open(&s)); assert(hid_move(&s,INT_MAX,INT_MIN,0xfffffff0));
    r=hid_peek(&s,0x10); assert(r && r->dx==32767 && r->dy==-32767); assert(!hid_peek(&s,0x50));
    hid_reset(&s);
    for(unsigned i=0;i<HID_QUEUE_SIZE/2;i++) assert(hid_key(&s,i+1,0x4f+i%4,100));
    assert(!hid_key(&s,99,0x52,100));
    for(unsigned i=0;i<HID_QUEUE_SIZE/2;i++) {
        r=hid_peek(&s,500); assert(r->keyboard && !r->consumer && !r->motion && r->usage==0x4f+i%4 && !r->id); hid_pop(&s);
        r=hid_peek(&s,500); assert(r->keyboard && !r->usage && r->id==i+1); hid_pop(&s);
    }
    assert(!hid_key(&s,100,0,500)); assert(!hid_key(&s,101,0x53,500)); assert(!s.count);
    puts("HID state checks passed");
}
