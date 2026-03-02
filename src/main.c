#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "./vendor/lua/lauxlib.h"
#include "./vendor/lua/lualib.h"

#if defined(__wasm__)
#define EXPORT(name) __attribute__((export_name(name)))
#else
#define EXPORT(name)
#endif

enum runner_error {
  RUNNER_OK = 0,
  RUNNER_ERR_BAD_ARG = 1,
  RUNNER_ERR_COMPILE = 2,
  RUNNER_ERR_RUNTIME = 3,
  RUNNER_ERR_INIT = 4,
};

#define INPUT_CAP 65536
#define OUTPUT_CAP 65536
#define ERROR_CAP 4096

static lua_State *g_lua = NULL;
static int32_t g_last_error = RUNNER_OK;

static char g_input[INPUT_CAP];
static char g_output[OUTPUT_CAP];
static char g_error[ERROR_CAP];

static int32_t g_output_len = 0;
static int32_t g_error_len = 0;

static void clear_output(void) {
  g_output_len = 0;
  g_output[0] = '\0';
}

static void clear_error(void) {
  g_error_len = 0;
  g_error[0] = '\0';
}

static void append_output(const char *s, size_t len) {
  size_t cap_left;
  if (len == 0 || g_output_len >= OUTPUT_CAP - 1)
    return;
  cap_left = (size_t)((OUTPUT_CAP - 1) - g_output_len);
  if (len > cap_left)
    len = cap_left;
  memcpy(g_output + g_output_len, s, len);
  g_output_len += (int32_t)len;
  g_output[g_output_len] = '\0';
}

static void set_error_message(const char *s) {
  size_t len;
  clear_error();
  if (s == NULL)
    return;
  len = strlen(s);
  if (len > (size_t)(ERROR_CAP - 1))
    len = (size_t)(ERROR_CAP - 1);
  memcpy(g_error, s, len);
  g_error_len = (int32_t)len;
  g_error[g_error_len] = '\0';
}

static int lua_print_bridge(lua_State *L) {
  int argc = lua_gettop(L);
  int i;
  for (i = 1; i <= argc; i++) {
    size_t len = 0;
    const char *s;
    luaL_tolstring(L, i, &len);
    s = lua_tostring(L, -1);
    append_output(s, len);
    if (i < argc)
      append_output("\t", 1);
    lua_pop(L, 1);
  }
  append_output("\n", 1);
  return 0;
}

static void open_safe_libs(lua_State *L) {
  luaL_requiref(L, "_G", luaopen_base, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_TABLIBNAME, luaopen_table, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_STRLIBNAME, luaopen_string, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_MATHLIBNAME, luaopen_math, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_UTF8LIBNAME, luaopen_utf8, 1);
  lua_pop(L, 1);
}

static int32_t map_lua_status(int status) {
  if (status == LUA_OK)
    return RUNNER_OK;
  if (status == LUA_ERRSYNTAX)
    return RUNNER_ERR_COMPILE;
  return RUNNER_ERR_RUNTIME;
}

EXPORT("init_runner")
int32_t init_runner(void) {
  if (g_lua != NULL) {
    lua_close(g_lua);
    g_lua = NULL;
  }

  clear_output();
  clear_error();
  g_last_error = RUNNER_OK;

  g_lua = luaL_newstate();
  if (g_lua == NULL) {
    g_last_error = RUNNER_ERR_INIT;
    set_error_message("failed to create lua state");
    return g_last_error;
  }

  open_safe_libs(g_lua);
  lua_pushcfunction(g_lua, lua_print_bridge);
  lua_setglobal(g_lua, "print");
  return RUNNER_OK;
}

EXPORT("run_input")
int32_t run_input(int32_t len) {
  int status;
  const char *err;
  if (g_lua == NULL) {
    g_last_error = RUNNER_ERR_INIT;
    set_error_message("runner is not initialized");
    return g_last_error;
  }
  if (len < 0 || len > INPUT_CAP) {
    g_last_error = RUNNER_ERR_BAD_ARG;
    set_error_message("invalid input length");
    return g_last_error;
  }

  clear_output();
  clear_error();

  status = luaL_loadbufferx(g_lua, g_input, (size_t)len, "input", "t");
  if (status == LUA_OK) {
    status = lua_pcall(g_lua, 0, LUA_MULTRET, 0);
  }

  g_last_error = map_lua_status(status);
  if (g_last_error != RUNNER_OK) {
    err = lua_tostring(g_lua, -1);
    set_error_message(err != NULL ? err : "unknown lua error");
    lua_pop(g_lua, 1);
  }
  return g_last_error;
}

EXPORT("clear_buffers")
int32_t clear_buffers(void) {
  clear_output();
  clear_error();
  g_last_error = RUNNER_OK;
  return RUNNER_OK;
}

EXPORT("get_input_ptr")
int32_t get_input_ptr(void) { return (int32_t)(intptr_t)g_input; }

EXPORT("get_input_cap")
int32_t get_input_cap(void) { return INPUT_CAP; }

EXPORT("get_output_ptr")
int32_t get_output_ptr(void) { return (int32_t)(intptr_t)g_output; }

EXPORT("get_output_len")
int32_t get_output_len(void) { return g_output_len; }

EXPORT("get_error_ptr")
int32_t get_error_ptr(void) { return (int32_t)(intptr_t)g_error; }

EXPORT("get_error_len")
int32_t get_error_len(void) { return g_error_len; }

EXPORT("get_last_error")
int32_t get_last_error(void) { return g_last_error; }

int main(void) { return 0; }
