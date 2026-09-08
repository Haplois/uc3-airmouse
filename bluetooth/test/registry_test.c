#define _POSIX_C_SOURCE 200809L
#ifdef NDEBUG
#undef NDEBUG
#endif
#include "host_registry.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static bool fail_file_sync, fail_directory_sync, fail_rename;
int __real_fsync(int fd);
int __real_rename(const char *from, const char *to);
int __wrap_fsync(int fd) {
    struct stat stat;
    assert(fstat(fd, &stat) == 0);
    if ((S_ISDIR(stat.st_mode) && fail_directory_sync) || (!S_ISDIR(stat.st_mode) && fail_file_sync)) {
        errno = EIO;
        return -1;
    }
    return __real_fsync(fd);
}
int __wrap_rename(const char *from, const char *to) {
    if (fail_rename) { errno = EIO; return -1; }
    return __real_rename(from, to);
}

static const uint8_t addresses[5][6] = {
    {1,2,3,4,5,6}, {2,3,4,5,6,7}, {3,4,5,6,7,8}, {4,5,6,7,8,9}, {5,6,7,8,9,10}
};

static void text_validation(void) {
    assert(hosts_valid_text("", 0));
    assert(!hosts_valid_text(NULL, 0));
    assert(hosts_valid_text("Desk \"PC\" \\ main", 16));
    const char unicode[] = "\xc3\xa9\xe6\xa1\x8c\xf0\x9f\x92\xbb";
    assert(hosts_valid_text(unicode, sizeof(unicode) - 1));
    char name[50];
    memset(name, 'a', sizeof(name));
    assert(hosts_valid_text(name, 48));
    assert(!hosts_valid_text(name, 49));
    for (unsigned c = 0; c < 32; c++) { name[0] = (char)c; assert(!hosts_valid_text(name, 1)); }
    name[0] = 127; assert(!hosts_valid_text(name, 1));
    for (unsigned c = 0x80; c <= 0x9f; c++) {
        name[0] = (char)0xc2; name[1] = (char)c;
        assert(!hosts_valid_text(name, 2));
    }
    const char *bad[] = {"\x80", "\xc0\xaf", "\xc1\xbf", "\xc2", "\xe0\x80\x80", "\xed\xa0\x80",
        "\xed\xbf\xbf", "\xf0\x80\x80\x80", "\xf4\x90\x80\x80", "\xf5\x80\x80\x80", "\xff", "\xe2\x28\xa1"};
    for (size_t i = 0; i < sizeof(bad)/sizeof(bad[0]); i++) assert(!hosts_valid_text(bad[i], strlen(bad[i])));
    assert(hosts_valid_text("\xf4\x8f\xbf\xbf", 4));
}

static size_t read_bytes(const char *path, uint8_t bytes[512]) {
    int fd = open(path, O_RDONLY);
    assert(fd >= 0);
    ssize_t count = read(fd, bytes, 512);
    assert(count >= 0 && count < 512);
    assert(close(fd) == 0);
    return (size_t)count;
}
static void write_bytes(const char *path, const uint8_t *bytes, size_t length) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    assert(fd >= 0);
    assert(write(fd, bytes, length) == (ssize_t)length);
    assert(close(fd) == 0);
}

static void roundtrip(const char *path) {
    host_registry registry, loaded;
    assert(hosts_load(&registry, path) == 0);
    assert(registry.count == 0 && registry.next_id == 1 && !registry.selected_id);
    assert(hosts_save(&registry) == 0);
    assert(hosts_load(&loaded, path) == 1 && loaded.count == 0);
    uint32_t first, second;
    assert(hosts_add(&registry, 2, 1, addresses[0], true, &first) == 0 && first == 1);
    assert(registry.legacy_id == first && registry.selected_id == first);
    char name[64]; hosts_name(hosts_by_id(&registry, first), name, sizeof(name));
    assert(!strcmp(name, "Computer 1"));
    assert(hosts_set_bluetooth_name(&registry, first, "Desk \"PC\" \\ main") == 0);
    assert(hosts_rename(&registry, first, "Work \xe6\xa1\x8c") == 0);
    assert(hosts_set_bluetooth_name(&registry, first, "Renamed computer") == 0);
    hosts_name(hosts_by_id(&registry, first), name, sizeof(name));
    assert(!strcmp(name, "Work \xe6\xa1\x8c"));
    hosts_name(hosts_by_id(&registry, first), name, 7);
    assert(!strcmp(name, "Work "));
    assert(hosts_add(&registry, 0, 0, addresses[1], false, &second) == 0 && second == 2);
    assert(registry.selected_id == second);
    uint32_t order[] = {second, first};
    assert(hosts_reorder(&registry, order, 2) == 0);
    assert(hosts_load(&loaded, path) == 1);
    assert(!memcmp(&registry, &loaded, sizeof(registry)));
    assert(loaded.records[0].id == second && loaded.legacy_id == first);
    assert(hosts_by_slot(&loaded, 2)->id == first);
    assert(hosts_rename(&loaded, first, "") == 0);
    hosts_name(hosts_by_id(&loaded, first), name, sizeof(name));
    assert(!strcmp(name, "Renamed computer"));
    assert(hosts_select(&loaded, first) == 0);
    assert(hosts_forget(&loaded, first) == 0);
    assert(!loaded.selected_id && !loaded.legacy_id && loaded.next_id == 3);
    assert(hosts_load(&registry, path) == 1);
    uint32_t third;
    assert(hosts_add(&registry, 2, 1, addresses[0], false, &third) == 0 && third == 3);
    assert(hosts_forget(&registry, second) == 0 && registry.selected_id == third);
    assert(hosts_forget(&registry, third) == 0 && registry.next_id == 4);
    assert(hosts_load(&loaded, path) == 1 && loaded.count == 0 && loaded.next_id == 4);
    struct stat stat;
    assert(lstat(path, &stat) == 0 && (stat.st_mode & 0777) == 0600);
    assert(unlink(path) == 0);
}

static void validation_and_limits(const char *path) {
    host_registry registry, before;
    assert(hosts_load(&registry, path) == 0);
    uint32_t id;
    assert(hosts_add(&registry, 0, 0, addresses[0], true, &id) == 0);
    before = registry;
    assert(hosts_add(&registry, 0, 0, addresses[1], false, NULL) == -1 && errno == EEXIST);
    assert(hosts_add(&registry, 1, 0, addresses[0], false, NULL) == -1 && errno == EEXIST);
    assert(hosts_add(&registry, 1, 0, addresses[1], true, NULL) == -1 && errno == EEXIST);
    assert(hosts_add(&registry, 4, 0, addresses[1], false, NULL) == -1 && errno == EINVAL);
    assert(hosts_add(&registry, 1, 2, addresses[1], false, NULL) == -1 && errno == EINVAL);
    assert(hosts_select(&registry, 99) == -1 && errno == ENOENT);
    assert(hosts_rename(&registry, id, "bad\nname") == -1 && errno == EINVAL);
    assert(hosts_set_bluetooth_name(&registry, id, "bad\xc0\xaf") == -1 && errno == EINVAL);
    assert(!memcmp(&before, &registry, sizeof(registry)));
    for (unsigned i = 1; i < 4; i++) assert(hosts_add(&registry, (uint8_t)i, 0, addresses[i], false, &id) == 0);
    assert(hosts_add(&registry, 0, 1, addresses[4], false, NULL) == -1 && errno == ENOSPC);
    before = registry;
    uint32_t wrong[] = {1,1,3,4};
    assert(hosts_reorder(&registry, wrong, 4) == -1);
    wrong[1] = 99; assert(hosts_reorder(&registry, wrong, 4) == -1);
    assert(hosts_reorder(&registry, wrong, 3) == -1);
    assert(hosts_reorder(&registry, NULL, 4) == -1);
    assert(!memcmp(&before, &registry, sizeof(registry)));
    assert(hosts_forget(&registry, 4) == 0);
    registry.next_id = UINT32_MAX;
    assert(hosts_add(&registry, 3, 0, addresses[3], false, &id) == 0 && id == UINT32_MAX);
    assert(!registry.next_id);
    assert(hosts_forget(&registry, id) == 0);
    assert(hosts_load(&before, path) == 1 && !before.next_id);
    assert(hosts_add(&before, 3, 0, addresses[3], false, &id) == -1 && errno == EOVERFLOW);
    assert(unlink(path) == 0);
}

static void corruption(const char *path) {
    host_registry registry, loaded;
    assert(hosts_load(&registry, path) == 0);
    assert(hosts_add(&registry, 0, 0, addresses[0], true, NULL) == 0);
    assert(hosts_add(&registry, 1, 1, addresses[1], false, NULL) == 0);
    assert(hosts_rename(&registry, 1, "abc") == 0);
    uint8_t original[512], corrupt[512];
    size_t length = read_bytes(path, original);
    assert(length == 244);
    const struct {size_t offset; uint8_t value;} changes[] = {
        {0, 'X'}, {7, '2'}, {8, 5}, {9, 1}, {12, 1}, {16, 99}, {20, 99},
        {24, 0}, {28, 4}, {29, 2}, {36, 49}, {37, 1}, {85, 4}, {86, '\n'},
        {89, 'z'}, {134, 1}, {138, 0}
    };
    for (size_t i = 0; i < sizeof(changes)/sizeof(changes[0]); i++) {
        memcpy(corrupt, original, length);
        corrupt[changes[i].offset] = changes[i].value;
        write_bytes(path, corrupt, length);
        loaded = registry;
        assert(hosts_load(&loaded, path) == -1 && errno == EINVAL);
        assert(!memcmp(&loaded, &registry, sizeof(registry)));
    }
    memcpy(corrupt, original, length);
    corrupt[139] = 0; memcpy(corrupt + 140, corrupt + 30, 6);
    write_bytes(path, corrupt, length);
    assert(hosts_load(&loaded, path) == -1);
    for (size_t i = 0; i < length; i++) {
        write_bytes(path, original, i);
        assert(hosts_load(&loaded, path) == -1);
    }
    memcpy(corrupt, original, length); corrupt[length] = 0;
    write_bytes(path, corrupt, length + 1);
    assert(hosts_load(&loaded, path) == -1);
    write_bytes(path, original, length);
    assert(chmod(path, 0644) == 0);
    assert(hosts_load(&loaded, path) == -1);
    assert(unlink(path) == 0);
    assert(symlink("/dev/null", path) == 0);
    assert(hosts_load(&loaded, path) == -1);
    assert(unlink(path) == 0);
    assert(mkfifo(path, 0600) == 0);
    assert(hosts_load(&loaded, path) == -1);
    assert(unlink(path) == 0);
}

static void atomic_failures(const char *directory, const char *path) {
    host_registry registry, before, loaded;
    assert(hosts_load(&registry, path) == 0);
    uint32_t id;
    assert(hosts_add(&registry, 0, 0, addresses[0], false, &id) == 0);
    before = registry;
    fail_file_sync = true;
    assert(hosts_rename(&registry, id, "Not saved") == -1 && errno == EIO);
    fail_file_sync = false;
    assert(!memcmp(&before, &registry, sizeof(registry)));
    assert(hosts_load(&loaded, path) == 1 && !memcmp(&before, &loaded, sizeof(loaded)));
    fail_rename = true;
    assert(hosts_rename(&registry, id, "Not renamed") == -1 && errno == EIO);
    fail_rename = false;
    assert(!memcmp(&before, &registry, sizeof(registry)));
    assert(hosts_load(&loaded, path) == 1 && !memcmp(&before, &loaded, sizeof(loaded)));
    fail_directory_sync = true;
    assert(hosts_rename(&registry, id, "Visible but not durable") == -1 && errno == EIO);
    fail_directory_sync = false;
    assert(!strcmp(hosts_by_id(&registry, id)->custom_name, "Visible but not durable"));
    assert(hosts_load(&loaded, path) == 1 && !memcmp(&registry, &loaded, sizeof(loaded)));
    assert(unlink(path) == 0);
    char absent[4096];
    assert(snprintf(absent, sizeof(absent), "%s/missing/hosts.dat", directory) > 0);
    assert(hosts_load(&registry, absent) == 0);
    before = registry;
    assert(hosts_add(&registry, 0, 0, addresses[0], false, &id) == -1 && errno == ENOENT);
    assert(!memcmp(&before, &registry, sizeof(registry)));
}

int main(void) {
    char directory[] = "/tmp/airmouse-registry-test-XXXXXX";
    assert(mkdtemp(directory));
    char path[4096];
    assert(snprintf(path, sizeof(path), "%s/hosts.dat", directory) > 0);
    text_validation();
    roundtrip(path);
    validation_and_limits(path);
    corruption(path);
    atomic_failures(directory, path);
    assert(rmdir(directory) == 0);
    puts("Host registry: persistence, names, ordering, ID exhaustion, corruption and atomic failure tests pass");
    return 0;
}
