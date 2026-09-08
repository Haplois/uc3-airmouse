#define _POSIX_C_SOURCE 200809L
#include "host_registry.h"
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum { HEADER_BYTES = 24, RECORD_BYTES = 110, FILE_BYTES = HEADER_BYTES + HOSTS_LIMIT * RECORD_BYTES };
/* AMHOST01, count, three zero bytes, little-endian next/selected/legacy IDs.
 * Records encode ID, slot, address type/address, then two length + 48-byte names.
 * Unused name bytes are zero; there are no native structs or bond keys on disk. */
static const uint8_t magic[8] = {'A', 'M', 'H', 'O', 'S', 'T', '0', '1'};

static int fail(int error) { errno = error; return -1; }

bool hosts_valid_text(const char *text, size_t length) {
    if (!text || length > HOSTS_NAME_BYTES) return false;
    for (size_t i = 0; i < length;) {
        uint32_t code = (uint8_t)text[i++];
        unsigned continuation = 0;
        uint32_t minimum = 0;
        if (code >= 0xc2 && code <= 0xdf) { continuation = 1; minimum = 0x80; code &= 0x1f; }
        else if (code >= 0xe0 && code <= 0xef) { continuation = 2; minimum = 0x800; code &= 0x0f; }
        else if (code >= 0xf0 && code <= 0xf4) { continuation = 3; minimum = 0x10000; code &= 0x07; }
        else if (code >= 0x80) return false;
        if (continuation > length - i) return false;
        while (continuation--) {
            uint8_t next = (uint8_t)text[i++];
            if ((next & 0xc0) != 0x80) return false;
            code = (code << 6) | (next & 0x3f);
        }
        if (code < minimum || code < 0x20 || (code >= 0x7f && code <= 0x9f) ||
            (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return false;
    }
    return true;
}

const host_record *hosts_by_id(const host_registry *registry, uint32_t id) {
    if (!registry || !id) return NULL;
    for (unsigned i = 0; i < registry->count; i++)
        if (registry->records[i].id == id) return &registry->records[i];
    return NULL;
}

const host_record *hosts_by_slot(const host_registry *registry, uint8_t slot) {
    if (!registry) return NULL;
    for (unsigned i = 0; i < registry->count; i++)
        if (registry->records[i].db_slot == slot) return &registry->records[i];
    return NULL;
}

void hosts_name(const host_record *record, char *buffer, size_t size) {
    if (!buffer || !size) return;
    if (!record) { buffer[0] = '\0'; return; }
    const char *name = record->custom_name[0] ? record->custom_name : record->bluetooth_name;
    if (name[0]) {
        size_t length = strlen(name);
        if (length >= size) {
            length = size - 1;
            while (length && ((uint8_t)name[length] & 0xc0) == 0x80) length--;
        }
        memcpy(buffer, name, length);
        buffer[length] = '\0';
    } else snprintf(buffer, size, "Computer %" PRIu32, record->id);
}

static bool valid(const host_registry *registry) {
    if (registry->count > HOSTS_LIMIT) return false;
    if (registry->selected_id && !hosts_by_id(registry, registry->selected_id)) return false;
    if (registry->legacy_id && !hosts_by_id(registry, registry->legacy_id)) return false;
    for (unsigned i = 0; i < registry->count; i++) {
        const host_record *record = &registry->records[i];
        if (!record->id || (registry->next_id && record->id >= registry->next_id) ||
            record->db_slot >= HOSTS_LIMIT || record->address_type > 1 ||
            !hosts_valid_text(record->bluetooth_name, strnlen(record->bluetooth_name, sizeof(record->bluetooth_name))) ||
            !hosts_valid_text(record->custom_name, strnlen(record->custom_name, sizeof(record->custom_name)))) return false;
        for (unsigned j = 0; j < i; j++) {
            const host_record *other = &registry->records[j];
            if (other->id == record->id || other->db_slot == record->db_slot ||
                (other->address_type == record->address_type && !memcmp(other->address, record->address, 6))) return false;
        }
    }
    return true;
}

static void put32(uint8_t *bytes, uint32_t value) {
    for (unsigned i = 0; i < 4; i++) bytes[i] = (uint8_t)(value >> (8 * i));
}
static uint32_t get32(const uint8_t *bytes) {
    uint32_t value = 0;
    for (unsigned i = 0; i < 4; i++) value |= (uint32_t)bytes[i] << (8 * i);
    return value;
}

static size_t encode(const host_registry *registry, uint8_t bytes[FILE_BYTES]) {
    memset(bytes, 0, FILE_BYTES);
    memcpy(bytes, magic, sizeof(magic));
    bytes[8] = registry->count;
    put32(bytes + 12, registry->next_id);
    put32(bytes + 16, registry->selected_id);
    put32(bytes + 20, registry->legacy_id);
    for (unsigned i = 0; i < registry->count; i++) {
        const host_record *record = &registry->records[i];
        uint8_t *out = bytes + HEADER_BYTES + i * RECORD_BYTES;
        put32(out, record->id);
        out[4] = record->db_slot;
        out[5] = record->address_type;
        memcpy(out + 6, record->address, 6);
        out[12] = (uint8_t)strlen(record->bluetooth_name);
        memcpy(out + 13, record->bluetooth_name, out[12]);
        out[61] = (uint8_t)strlen(record->custom_name);
        memcpy(out + 62, record->custom_name, out[61]);
    }
    return HEADER_BYTES + registry->count * RECORD_BYTES;
}

static bool decode_name(char out[49], const uint8_t *bytes) {
    size_t length = bytes[0];
    if (!hosts_valid_text((const char *)bytes + 1, length)) return false;
    for (size_t i = length; i < HOSTS_NAME_BYTES; i++) if (bytes[i + 1]) return false;
    memcpy(out, bytes + 1, length);
    out[length] = '\0';
    return true;
}

int hosts_load(host_registry *registry, const char *path) {
    if (!registry || !path || !path[0] || strlen(path) >= sizeof(registry->path)) return fail(EINVAL);
    host_registry loaded = { .next_id = 1 };
    memcpy(loaded.path, path, strlen(path) + 1);
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) {
        if (errno != ENOENT) return -1;
        *registry = loaded;
        return 0;
    }
    struct stat stat;
    if (fstat(fd, &stat) < 0) { int error = errno; close(fd); return fail(error); }
    if (!S_ISREG(stat.st_mode) || (stat.st_mode & 0077) || stat.st_size < HEADER_BYTES || stat.st_size > FILE_BYTES) {
        close(fd);
        return fail(EINVAL);
    }
    uint8_t bytes[FILE_BYTES + 1];
    size_t length = 0;
    for (;;) {
        ssize_t count = read(fd, bytes + length, sizeof(bytes) - length);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { int error = errno; close(fd); return fail(error); }
        if (!count) break;
        length += (size_t)count;
        if (length == sizeof(bytes)) { close(fd); return fail(EINVAL); }
    }
    if (close(fd) < 0) return -1;
    if (length < HEADER_BYTES || memcmp(bytes, magic, sizeof(magic)) || bytes[9] || bytes[10] || bytes[11] ||
        bytes[8] > HOSTS_LIMIT || length != (size_t)HEADER_BYTES + bytes[8] * RECORD_BYTES) return fail(EINVAL);
    loaded.count = bytes[8];
    loaded.next_id = get32(bytes + 12);
    loaded.selected_id = get32(bytes + 16);
    loaded.legacy_id = get32(bytes + 20);
    for (unsigned i = 0; i < loaded.count; i++) {
        host_record *record = &loaded.records[i];
        const uint8_t *in = bytes + HEADER_BYTES + i * RECORD_BYTES;
        record->id = get32(in);
        record->db_slot = in[4];
        record->address_type = in[5];
        memcpy(record->address, in + 6, 6);
        if (!decode_name(record->bluetooth_name, in + 12) || !decode_name(record->custom_name, in + 61)) return fail(EINVAL);
    }
    if (!valid(&loaded)) return fail(EINVAL);
    *registry = loaded;
    return 1;
}

static int publish(host_registry *registry, const host_registry *candidate) {
    if (!valid(candidate)) return fail(EINVAL);
    char directory[sizeof(registry->path)], temporary[sizeof(registry->path) + 16];
    memcpy(directory, candidate->path, sizeof(directory));
    char *slash = strrchr(directory, '/');
    if (slash == directory) slash[1] = '\0';
    else if (slash) *slash = '\0';
    else strcpy(directory, ".");
    int directory_fd = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (directory_fd < 0) return -1;
    int length = snprintf(temporary, sizeof(temporary), "%s.tmp.XXXXXX", candidate->path);
    if (length < 0 || (size_t)length >= sizeof(temporary)) { close(directory_fd); return fail(ENAMETOOLONG); }
    int fd = mkstemp(temporary);
    if (fd < 0) { int error = errno; close(directory_fd); return fail(error); }
    int error = 0;
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0 || fchmod(fd, 0600) < 0) error = errno;
    uint8_t bytes[FILE_BYTES];
    size_t size = encode(candidate, bytes), offset = 0;
    while (!error && offset < size) {
        ssize_t count = write(fd, bytes + offset, size - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { error = count < 0 ? errno : EIO; break; }
        offset += (size_t)count;
    }
    if (!error && fsync(fd) < 0) error = errno;
    if (close(fd) < 0 && !error) error = errno;
    if (!error && rename(temporary, candidate->path) < 0) error = errno;
    if (error) {
        unlink(temporary);
        close(directory_fd);
        return fail(error);
    }
    *registry = *candidate;
    if (fsync(directory_fd) < 0) error = errno;
    if (close(directory_fd) < 0 && !error) error = errno;
    return error ? fail(error) : 0;
}

int hosts_save(host_registry *registry) {
    if (!registry) return fail(EINVAL);
    host_registry candidate = *registry;
    return publish(registry, &candidate);
}

int hosts_add(host_registry *registry, uint8_t slot, uint8_t type,
              const uint8_t address[6], bool legacy, uint32_t *out_id) {
    if (!registry || !address || slot >= HOSTS_LIMIT || type > 1) return fail(EINVAL);
    if (registry->count >= HOSTS_LIMIT) return fail(ENOSPC);
    if (!registry->next_id) return fail(EOVERFLOW);
    if ((legacy && registry->legacy_id) || hosts_by_slot(registry, slot)) return fail(EEXIST);
    for (unsigned i = 0; i < registry->count; i++)
        if (registry->records[i].address_type == type && !memcmp(registry->records[i].address, address, 6)) return fail(EEXIST);
    host_registry candidate = *registry;
    host_record *record = &candidate.records[candidate.count++];
    memset(record, 0, sizeof(*record));
    record->id = candidate.next_id++;
    record->db_slot = slot;
    record->address_type = type;
    memcpy(record->address, address, 6);
    candidate.selected_id = record->id;
    if (legacy) candidate.legacy_id = record->id;
    uint32_t id = record->id;
    if (publish(registry, &candidate) < 0) return -1;
    if (out_id) *out_id = id;
    return 0;
}

int hosts_select(host_registry *registry, uint32_t id) {
    if (!registry) return fail(EINVAL);
    if (id && !hosts_by_id(registry, id)) return fail(ENOENT);
    if (registry->selected_id == id) return 0;
    host_registry candidate = *registry;
    candidate.selected_id = id;
    return publish(registry, &candidate);
}

static int set_name(host_registry *registry, uint32_t id, const char *name, bool bluetooth) {
    if (!registry || !name || !hosts_valid_text(name, strnlen(name, HOSTS_NAME_BYTES + 1))) return fail(EINVAL);
    const host_record *record = hosts_by_id(registry, id);
    if (!record) return fail(ENOENT);
    if (!strcmp(bluetooth ? record->bluetooth_name : record->custom_name, name)) return 0;
    host_registry candidate = *registry;
    host_record *changed = &candidate.records[record - registry->records];
    char *target = bluetooth ? changed->bluetooth_name : changed->custom_name;
    memset(target, 0, HOSTS_NAME_BYTES + 1);
    memcpy(target, name, strlen(name));
    return publish(registry, &candidate);
}

int hosts_rename(host_registry *registry, uint32_t id, const char *name) { return set_name(registry, id, name, false); }
int hosts_set_bluetooth_name(host_registry *registry, uint32_t id, const char *name) { return set_name(registry, id, name, true); }

int hosts_reorder(host_registry *registry, const uint32_t *ids, size_t count) {
    if (!registry || count != registry->count || (count && !ids)) return fail(EINVAL);
    host_registry candidate = *registry;
    bool changed = false;
    for (size_t i = 0; i < count; i++) {
        const host_record *record = hosts_by_id(registry, ids[i]);
        if (!record) return fail(EINVAL);
        for (size_t j = 0; j < i; j++) if (ids[j] == ids[i]) return fail(EINVAL);
        candidate.records[i] = *record;
        if (ids[i] != registry->records[i].id) changed = true;
    }
    return changed ? publish(registry, &candidate) : 0;
}

int hosts_forget(host_registry *registry, uint32_t id) {
    if (!registry) return fail(EINVAL);
    const host_record *record = hosts_by_id(registry, id);
    if (!record) return fail(ENOENT);
    host_registry candidate = *registry;
    size_t index = (size_t)(record - registry->records);
    memmove(candidate.records + index, candidate.records + index + 1,
            (candidate.count - index - 1) * sizeof(host_record));
    memset(&candidate.records[--candidate.count], 0, sizeof(host_record));
    if (candidate.selected_id == id) candidate.selected_id = 0;
    if (candidate.legacy_id == id) candidate.legacy_id = 0;
    return publish(registry, &candidate);
}
