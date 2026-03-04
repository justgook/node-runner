#include <stdint.h>
#include <stdlib.h>

#include "vendor/lua/lauxlib.h"
#include "vendor/lua/lua.h"
#include "vendor/lua/lualib.h"

#ifdef __cplusplus
extern "C" {
#endif

#ifndef LUA_OK
#define LUA_OK 0
#endif

__attribute__((import_module("env"), import_name("host_print"))) extern void
host_print(const char *msg, int len);
__attribute__((import_module("env"), import_name("host_error"))) extern void
host_error(const char *msg, int len);
__attribute__((import_module("env"), import_name("host_http_get"))) extern void
host_http_get(int request_id, const char *url, int len);

typedef struct PendingRequest {
  int request_id;
  int callback_ref;
} PendingRequest;

static lua_State *G_L = NULL;
static int G_next_request_id = 1;
static PendingRequest G_pending[256];

static void send_host_error(const char *msg, size_t len) {
  if (msg == NULL) {
    return;
  }
  host_error(msg, (int)len);
}

static int traceback(lua_State *L) {
  const char *msg = lua_tostring(L, 1);
  if (msg != NULL) {
    luaL_traceback(L, L, msg, 1);
  } else {
    lua_pushliteral(L, "(error object is not a string)");
  }
  return 1;
}

static int pcall_with_traceback(lua_State *L, int nargs, int nresults) {
  int base = lua_gettop(L) - nargs;
  lua_pushcfunction(L, traceback);
  lua_insert(L, base);
  int status = lua_pcall(L, nargs, nresults, base);
  lua_remove(L, base);
  return status;
}

static int l_print(lua_State *L) {
  int top = lua_gettop(L);
  luaL_Buffer buffer;
  luaL_buffinit(L, &buffer);

  for (int i = 1; i <= top; i++) {
    size_t arg_len = 0;
    const char *arg = luaL_tolstring(L, i, &arg_len);
    if (i > 1) {
      luaL_addchar(&buffer, '\t');
    }
    luaL_addlstring(&buffer, arg, arg_len);
    lua_pop(L, 1);
  }

  luaL_addchar(&buffer, '\n');
  luaL_pushresult(&buffer);
  size_t out_len = 0;
  const char *out = lua_tolstring(L, -1, &out_len);
  host_print(out, (int)out_len);
  lua_pop(L, 1);
  return 0;
}

static int add_pending_request(int request_id, int callback_ref) {
  for (int i = 0; i < 256; i++) {
    if (G_pending[i].request_id == 0) {
      G_pending[i].request_id = request_id;
      G_pending[i].callback_ref = callback_ref;
      return 1;
    }
  }
  return 0;
}

static int take_pending_ref(int request_id) {
  for (int i = 0; i < 256; i++) {
    if (G_pending[i].request_id == request_id) {
      int ref = G_pending[i].callback_ref;
      G_pending[i].request_id = 0;
      G_pending[i].callback_ref = LUA_REFNIL;
      return ref;
    }
  }
  return LUA_REFNIL;
}

static int l_host_http_get(lua_State *L) {
  size_t url_len = 0;
  const char *url = luaL_checklstring(L, 1, &url_len);
  luaL_checktype(L, 2, LUA_TFUNCTION);

  lua_pushvalue(L, 2);
  int callback_ref = luaL_ref(L, LUA_REGISTRYINDEX);
  int request_id = G_next_request_id++;

  if (!add_pending_request(request_id, callback_ref)) {
    luaL_unref(L, LUA_REGISTRYINDEX, callback_ref);
    return luaL_error(L, "too many pending host requests");
  }

  host_http_get(request_id, url, (int)url_len);
  return 0;
}

static void open_selected_libs(lua_State *L) {
  luaL_requiref(L, LUA_GNAME, luaopen_base, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_COLIBNAME, luaopen_coroutine, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_TABLIBNAME, luaopen_table, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_STRLIBNAME, luaopen_string, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_MATHLIBNAME, luaopen_math, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_UTF8LIBNAME, luaopen_utf8, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_DBLIBNAME, luaopen_debug, 1);
  lua_pop(L, 1);
}

__attribute__((export_name("wasm_alloc"))) void *wasm_alloc(int size) {
  if (size <= 0) {
    return NULL;
  }
  return malloc((size_t)size);
}

__attribute__((export_name("wasm_dealloc"))) void wasm_dealloc(void *ptr) {
  free(ptr);
}

__attribute__((export_name("wasm_init"))) int wasm_init(void) {
  if (G_L != NULL) {
    lua_close(G_L);
    G_L = NULL;
  }

  G_L = luaL_newstate();
  if (G_L == NULL) {
    send_host_error("failed to create lua state", 26);
    return 1;
  }

  for (int i = 0; i < 256; i++) {
    G_pending[i].request_id = 0;
    G_pending[i].callback_ref = LUA_REFNIL;
  }
  G_next_request_id = 1;

  open_selected_libs(G_L);

  lua_pushcfunction(G_L, l_print);
  lua_setglobal(G_L, "print");

  lua_newtable(G_L);
  lua_pushcfunction(G_L, l_host_http_get);
  lua_setfield(G_L, -2, "http_get");
  lua_setglobal(G_L, "host");

  return 0;
}

__attribute__((export_name("wasm_run"))) int wasm_run(const char *code, int code_len) {
  if (G_L == NULL) {
    send_host_error("lua state is not initialized", 28);
    return 1;
  }

  int load_status = luaL_loadbuffer(G_L, code, (size_t)code_len, "textarea");
  if (load_status != LUA_OK) {
    size_t err_len = 0;
    const char *err = lua_tolstring(G_L, -1, &err_len);
    send_host_error(err, err_len);
    lua_pop(G_L, 1);
    return load_status;
  }

  int status = pcall_with_traceback(G_L, 0, 0);
  if (status != LUA_OK) {
    size_t err_len = 0;
    const char *err = lua_tolstring(G_L, -1, &err_len);
    send_host_error(err, err_len);
    lua_pop(G_L, 1);
  }

  return status;
}

__attribute__((export_name("wasm_http_response"))) int wasm_http_response(
    int request_id,
    int status_code,
    const char *body,
    int body_len,
    const char *err,
    int err_len) {
  if (G_L == NULL) {
    send_host_error("lua state is not initialized", 28);
    return 1;
  }

  int callback_ref = take_pending_ref(request_id);
  if (callback_ref == LUA_REFNIL) {
    send_host_error("unknown request id in wasm_http_response", 40);
    return 1;
  }

  lua_rawgeti(G_L, LUA_REGISTRYINDEX, callback_ref);
  luaL_unref(G_L, LUA_REGISTRYINDEX, callback_ref);

  if (err != NULL && err_len > 0) {
    lua_pushlstring(G_L, err, (size_t)err_len);
  } else {
    lua_pushnil(G_L);
  }

  if (body != NULL && body_len >= 0) {
    lua_pushlstring(G_L, body, (size_t)body_len);
  } else {
    lua_pushliteral(G_L, "");
  }

  lua_pushinteger(G_L, status_code);

  int call_status = pcall_with_traceback(G_L, 3, 0);
  if (call_status != LUA_OK) {
    size_t call_err_len = 0;
    const char *call_err = lua_tolstring(G_L, -1, &call_err_len);
    send_host_error(call_err, call_err_len);
    lua_pop(G_L, 1);
  }

  return call_status;
}

int main(void) {
  return 0;
}

#ifdef __cplusplus
}
#endif
