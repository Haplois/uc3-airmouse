#define _GNU_SOURCE
#include <node_api.h>
#include <uv.h>
#include <linux/input.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    uv_poll_t poll;
    napi_env env;
    napi_ref callback;
    int fd;
    int closed;
    int finalized;
    int handle_closed;
} reader;

static void freed(uv_handle_t *handle) {
    reader *r = handle->data;
    r->handle_closed = 1;
    if (r->finalized) free(r);
}

static void stop(reader *r) {
    if (r->closed) return;
    r->closed = 1;
    uv_poll_stop(&r->poll);
    close(r->fd);
    napi_delete_reference(r->env, r->callback);
    uv_close((uv_handle_t *)&r->poll, freed);
}

static void finalize(napi_env env, void *data, void *hint) {
    (void)env; (void)hint;
    reader *r = data;
    r->finalized = 1;
    if (r->handle_closed) free(r);
    else stop(r);
}

static void ready(uv_poll_t *handle, int status, int events) {
    (void)events;
    reader *r = handle->data;
    char bytes[6144];
    ssize_t count = status < 0 ? -1 : read(r->fd, bytes, sizeof(bytes));
    if (count < 0 && status >= 0 && (errno == EAGAIN || errno == EINTR)) return;
    napi_handle_scope scope;
    napi_open_handle_scope(r->env, &scope);
    napi_value callback, receiver, args[2], result;
    napi_get_reference_value(r->env, r->callback, &callback);
    napi_get_undefined(r->env, &receiver);
    napi_get_null(r->env, &args[0]);
    napi_get_null(r->env, &args[1]);
    if (count > 0) napi_create_buffer_copy(r->env, (size_t)count, bytes, NULL, &args[1]);
    else {
        napi_create_string_utf8(r->env, count == 0 ? "Sensor input closed" : "Sensor input read failed", NAPI_AUTO_LENGTH, &args[0]);
        stop(r);
    }
    napi_call_function(r->env, receiver, callback, 2, args, &result);
    napi_close_handle_scope(r->env, scope);
}

static napi_value watch(napi_env env, napi_callback_info info) {
    size_t argc = 4, length;
    napi_value argv[4], external;
    char path[4096];
    bool wake = false, grab = false;
    napi_valuetype type;
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (argc != 4 || napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &length) != napi_ok
        || length >= sizeof(path) - 1 || napi_get_value_bool(env, argv[1], &wake) != napi_ok
        || napi_get_value_bool(env, argv[2], &grab) != napi_ok
        || napi_typeof(env, argv[3], &type) != napi_ok || type != napi_function || (grab && !wake)) {
        napi_throw_error(env, NULL, "Invalid sensor reader arguments"); return NULL;
    }
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) { napi_throw_error(env, NULL, strerror(errno)); return NULL; }
    if (wake) {
        char name[128] = {0};
        if (ioctl(fd, EVIOCGNAME(sizeof(name)), name) < 0 || strcmp(name, "bmi323")
            || (grab && ioctl(fd, EVIOCGRAB, 1) < 0)) {
            close(fd); napi_throw_error(env, NULL, "Cannot acquire BMI323 wake input"); return NULL;
        }
    }
    reader *r = calloc(1, sizeof(*r));
    if (!r) { close(fd); napi_throw_error(env, NULL, "Sensor reader allocation failed"); return NULL; }
    r->env = env; r->fd = fd;
    uv_loop_t *loop;
    napi_get_uv_event_loop(env, &loop);
    int code = uv_poll_init(loop, &r->poll, fd);
    if (code) { close(fd); free(r); napi_throw_error(env, NULL, uv_strerror(code)); return NULL; }
    r->poll.data = r;
    napi_create_reference(env, argv[3], 1, &r->callback);
    code = uv_poll_start(&r->poll, UV_READABLE, ready);
    if (code) { r->finalized = 1; stop(r); napi_throw_error(env, NULL, uv_strerror(code)); return NULL; }
    napi_create_external(env, r, finalize, NULL, &external);
    return external;
}

static napi_value close_reader(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1], result;
    void *data;
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (argc != 1 || napi_get_value_external(env, argv[0], &data) != napi_ok) {
        napi_throw_error(env, NULL, "Invalid sensor reader"); return NULL;
    }
    stop(data);
    napi_get_undefined(env, &result);
    return result;
}

static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        {"watch", NULL, watch, NULL, NULL, NULL, napi_default, NULL},
        {"close", NULL, close_reader, NULL, NULL, NULL, napi_default, NULL},
    };
    napi_define_properties(env, exports, 2, properties);
    return exports;
}
NAPI_MODULE(sensor_io, init)
