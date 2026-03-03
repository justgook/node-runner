#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "./vendor/lua/lauxlib.h"
#include "./vendor/lua/lualib.h"
#include "ng.h"

static NgInfo g_info;
static lua_State *g_lua = NULL;
static char g_code_buf[NG_IO_BUFFER_CAP];
static char g_resp_buf[NG_IO_BUFFER_CAP];
static NgValueSlot g_output_slots[NG_MAX_NODES][NG_MAX_OUTPUTS];
static char g_value_buf[NG_IO_BUFFER_CAP];
static ng_i32 g_value_len = 0;

typedef struct {
  ng_i32 active;
  ng_u32 target_goal_id;
  ng_u32 next_goal_scan;
  ng_u32 pending_request_id;
  ng_u32 pending_node_id;
  ng_u32 next_request_id;
  ng_i32 has_response;
  ng_i32 response_len;
  ng_i32 cancelled;
  lua_State *pending_co;
  ng_i32 pending_co_ref;
} NgRunCtx;

static NgRunCtx g_run;

static void clear_value_store(void) {
  g_value_len = 0;
  memset(g_output_slots, 0, sizeof(g_output_slots));
}

static ng_i32 value_alloc_and_copy(const char *src, ng_i32 len) {
  ng_i32 off;
  if (src == NULL || len < 0)
    return -1;
  if (len == 0)
    return 0;
  if (g_value_len + len > NG_IO_BUFFER_CAP)
    return -1;
  off = g_value_len;
  memcpy(g_value_buf + off, src, (size_t)len);
  g_value_len += len;
  return off;
}

static void set_last_error(ng_i32 err) { g_info.last_error = err; }

static void notify_node_changed(ng_u32 node_id, ng_u32 change_mask) {
  ng_on_node_changed(node_id, change_mask);
}

static void notify_run_event(ng_u32 node_id, ng_u32 event_kind,
                             ng_i32 error_code) {
  ng_on_run_event(node_id, event_kind, error_code);
}

static void set_run_status(ng_u32 status) { g_info.run_status = status; }

static void set_waiting(ng_u32 request_id, ng_u32 node_id) {
  g_info.waiting_request_id = request_id;
  g_info.waiting_node_id = node_id;
}

static void clear_waiting(void) { set_waiting(0, 0); }

static void clear_io(void) {
  g_info.io_len = 0;
  g_info.io_buf[0] = '\0';
}

static void append_io(const char *s, size_t len) {
  size_t cap_left;
  if (len == 0 || g_info.io_len >= NG_IO_BUFFER_CAP - 1)
    return;
  cap_left = (size_t)((NG_IO_BUFFER_CAP - 1) - g_info.io_len);
  if (len > cap_left)
    len = cap_left;
  memcpy(g_info.io_buf + g_info.io_len, s, len);
  g_info.io_len += (ng_i32)len;
  g_info.io_buf[g_info.io_len] = '\0';
}

static int lua_print_bridge(lua_State *L) {
  int argc = lua_gettop(L);
  int i;
  for (i = 1; i <= argc; i++) {
    size_t len = 0;
    const char *s;
    luaL_tolstring(L, i, &len);
    s = lua_tostring(L, -1);
    append_io(s, len);
    if (i < argc)
      append_io("\t", 1);
    lua_pop(L, 1);
  }
  append_io("\n", 1);
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

static ng_i32 init_lua(void) {
  if (g_lua != NULL) {
    lua_close(g_lua);
    g_lua = NULL;
  }
  g_lua = luaL_newstate();
  if (g_lua == NULL)
    return NG_ERR_RUNTIME;
  open_safe_libs(g_lua);
  lua_pushcfunction(g_lua, lua_print_bridge);
  lua_setglobal(g_lua, "print");
  return NG_OK;
}

static NgNode *find_node(ng_u32 node_id) {
  ng_u32 i;
  for (i = 0; i < NG_MAX_NODES; i++) {
    if (g_info.nodes[i].id == node_id)
      return &g_info.nodes[i];
  }
  return NULL;
}

static ng_i32 find_node_index(ng_u32 node_id) {
  ng_u32 i;
  for (i = 0; i < NG_MAX_NODES; i++) {
    if (g_info.nodes[i].id == node_id)
      return (ng_i32)i;
  }
  return -1;
}

static NgNode *alloc_node_slot(void) {
  ng_u32 i;
  for (i = 0; i < NG_MAX_NODES; i++) {
    if (g_info.nodes[i].id == 0)
      return &g_info.nodes[i];
  }
  return NULL;
}

static ng_i32 find_input_index(NgNode *node, ng_u32 input_id) {
  ng_u32 i;
  for (i = 0; i < node->input_count; i++) {
    if (node->inputs[i].id == input_id)
      return (ng_i32)i;
  }
  return -1;
}

static ng_i32 find_output_index(NgNode *node, ng_u32 output_id) {
  ng_u32 i;
  for (i = 0; i < node->output_count; i++) {
    if (node->outputs[i].id == output_id)
      return (ng_i32)i;
  }
  return -1;
}

static void split_i64(int64_t v, ng_i32 *a, ng_i32 *b) {
  uint64_t u = (uint64_t)v;
  *a = (ng_i32)(u & 0xffffffffu);
  *b = (ng_i32)((u >> 32) & 0xffffffffu);
}

static int64_t join_i64(ng_i32 a, ng_i32 b) {
  uint64_t u = ((uint64_t)(uint32_t)b << 32) | (uint32_t)a;
  return (int64_t)u;
}

static void split_f64(double v, ng_i32 *a, ng_i32 *b) {
  uint64_t u = 0;
  memcpy(&u, &v, sizeof(u));
  *a = (ng_i32)(u & 0xffffffffu);
  *b = (ng_i32)((u >> 32) & 0xffffffffu);
}

static double join_f64(ng_i32 a, ng_i32 b) {
  uint64_t u = ((uint64_t)(uint32_t)b << 32) | (uint32_t)a;
  double v = 0;
  memcpy(&v, &u, sizeof(v));
  return v;
}

static void clear_node_output_slots(ng_i32 node_idx) {
  if (node_idx < 0 || node_idx >= (ng_i32)NG_MAX_NODES)
    return;
  memset(g_output_slots[node_idx], 0, sizeof(g_output_slots[node_idx]));
}

static NgValueSlot *find_output_slot(ng_u32 node_id, ng_u32 output_id) {
  ng_i32 node_idx = find_node_index(node_id);
  NgNode *node;
  ng_i32 out_idx;
  if (node_idx < 0)
    return NULL;
  node = &g_info.nodes[node_idx];
  out_idx = find_output_index(node, output_id);
  if (out_idx < 0)
    return NULL;
  return &g_output_slots[node_idx][out_idx];
}

static void push_slot_to_lua(lua_State *L, const NgValueSlot *slot) {
  if (slot == NULL || slot->type == NG_VAL_EMPTY) {
    lua_pushnil(L);
    return;
  }
  if (slot->type == NG_VAL_BOOL) {
    lua_pushboolean(L, slot->a ? 1 : 0);
    return;
  }
  if (slot->type == NG_VAL_I64) {
    lua_pushinteger(L, (lua_Integer)join_i64(slot->a, slot->b));
    return;
  }
  if (slot->type == NG_VAL_F64) {
    lua_pushnumber(L, (lua_Number)join_f64(slot->a, slot->b));
    return;
  }
  if ((slot->type == NG_VAL_STRING_REF || slot->type == NG_VAL_BYTES_REF) &&
      slot->a >= 0 && slot->b >= 0 && slot->a + slot->b <= g_value_len) {
    lua_pushlstring(L, g_value_buf + slot->a, (size_t)slot->b);
    return;
  }
  lua_pushnil(L);
}

static ng_i32 read_lua_to_slot(lua_State *L, int idx, NgValueSlot *slot) {
  int t = lua_type(L, idx);
  memset(slot, 0, sizeof(*slot));
  if (t == LUA_TNIL) {
    slot->type = NG_VAL_EMPTY;
    return NG_OK;
  }
  if (t == LUA_TBOOLEAN) {
    slot->type = NG_VAL_BOOL;
    slot->a = lua_toboolean(L, idx) ? 1 : 0;
    return NG_OK;
  }
  if (t == LUA_TNUMBER) {
    if (lua_isinteger(L, idx)) {
      int64_t v = (int64_t)lua_tointeger(L, idx);
      slot->type = NG_VAL_I64;
      split_i64(v, &slot->a, &slot->b);
      return NG_OK;
    }
    slot->type = NG_VAL_F64;
    split_f64((double)lua_tonumber(L, idx), &slot->a, &slot->b);
    return NG_OK;
  }
  {
    size_t len = 0;
    const char *s = lua_tolstring(L, idx, &len);
    ng_i32 off;
    if (s == NULL)
      return NG_ERR_VALIDATION;
    off = value_alloc_and_copy(s, (ng_i32)len);
    if (off < 0)
      return NG_ERR_CAPACITY;
    slot->type = NG_VAL_STRING_REF;
    slot->a = off;
    slot->b = (ng_i32)len;
    return NG_OK;
  }
}

static void push_node_inputs_table(lua_State *co, NgNode *node) {
  ng_u32 i;
  lua_newtable(co);
  for (i = 0; i < node->input_count; i++) {
    NgInputPort *in = &node->inputs[i];
    NgValueSlot *slot = NULL;
    if (in->src_node_id != 0) {
      slot = find_output_slot(in->src_node_id, in->src_output_id);
    }
    push_slot_to_lua(co, slot);
    lua_seti(co, -2, (lua_Integer)in->id);
  }
}

static ng_i32 capture_node_outputs(lua_State *co, NgNode *node,
                                   ng_i32 node_idx) {
  ng_u32 i;
  clear_node_output_slots(node_idx);
  if (lua_gettop(co) < 1 || !lua_istable(co, -1))
    return NG_OK;
  for (i = 0; i < node->output_count; i++) {
    NgValueSlot slot;
    ng_i32 err;
    lua_geti(co, -1, (lua_Integer)node->outputs[i].id);
    err = read_lua_to_slot(co, -1, &slot);
    lua_pop(co, 1);
    if (err != NG_OK)
      return err;
    g_output_slots[node_idx][i] = slot;
  }
  return NG_OK;
}

static void mark_stale_downstream(ng_u32 src_node_id) {
  ng_u32 i;
  ng_u32 j;
  for (i = 0; i < NG_MAX_NODES; i++) {
    NgNode *node = &g_info.nodes[i];
    if (node->id == 0 || node->id == src_node_id)
      continue;
    for (j = 0; j < node->input_count; j++) {
      if (node->inputs[j].src_node_id == src_node_id) {
        if (node->exec_state == NG_EXEC_SUCCESS)
          node->exec_state = NG_EXEC_STALE;
        mark_stale_downstream(node->id);
        break;
      }
    }
  }
}

static void refresh_active_goal_count(void) {
  ng_u32 i;
  g_info.active_goal_count = 0;
  for (i = 0; i < NG_MAX_NODES; i++) {
    NgNode *node = &g_info.nodes[i];
    if (node->id == 0)
      continue;
    if (node->kind != NG_NODE_GOAL)
      continue;
    g_info.active_goal_count += 1;
  }
}

static int lua_host_await_call(lua_State *L) {
  size_t service_len = 0;
  size_t method_len = 0;
  size_t payload_len = 0;
  const char *service;
  const char *method;
  const char *payload = "{}";
  ng_i32 req_len;
  ng_i32 out_len;
  ng_i32 err;

  if (!lua_isstring(L, 1) || !lua_isstring(L, 2))
    return luaL_error(L, "host.awaitCall(service, method, payloadJson?)");

  service = lua_tolstring(L, 1, &service_len);
  method = lua_tolstring(L, 2, &method_len);
  if (lua_gettop(L) >= 3 && lua_isstring(L, 3))
    payload = lua_tolstring(L, 3, &payload_len);
  else
    payload_len = 2;

  if (!g_run.active)
    return luaL_error(L, "awaitCall outside active run");

  if (service_len + method_len + payload_len + 2 >= NG_IO_BUFFER_CAP)
    return luaL_error(L, "awaitCall request too large");

  memcpy(g_code_buf, service, service_len);
  g_code_buf[service_len] = '|';
  memcpy(g_code_buf + service_len + 1, method, method_len);
  g_code_buf[service_len + 1 + method_len] = '|';
  memcpy(g_code_buf + service_len + 2 + method_len, payload, payload_len);
  req_len = (ng_i32)(service_len + method_len + payload_len + 2);

  out_len = 0;
  err = ng_host_resolve(g_run.pending_node_id, NG_RESOLVE_CALL, g_code_buf,
                        req_len, g_resp_buf, NG_IO_BUFFER_CAP, &out_len);
  if (err != NG_OK || out_len < 0)
    return luaL_error(L, "host awaitCall resolve failed");

  lua_pushlstring(L, g_resp_buf, (size_t)out_len);
  return 1;
}

static ng_i32 load_wrapped_code(lua_State *L, const char *src, size_t len) {
  int status;
  luaL_Buffer b;
  luaL_buffinit(L, &b);
  luaL_addstring(&b, "return function(inputs, host)\nlocal outputs = {}\n");
  luaL_addlstring(&b, src, len);
  luaL_addstring(&b, "\nreturn outputs\nend");
  luaL_pushresult(&b);

  status = luaL_loadbufferx(L, lua_tostring(L, -1), (size_t)lua_rawlen(L, -1),
                            "node-code", "t");
  lua_remove(L, -2);
  if (status != LUA_OK)
    return NG_ERR_RUNTIME;
  status = lua_pcall(L, 0, 1, 0);
  if (status != LUA_OK)
    return NG_ERR_RUNTIME;
  if (!lua_isfunction(L, -1)) {
    lua_pop(L, 1);
    return NG_ERR_RUNTIME;
  }
  return NG_OK;
}

static ng_i32 start_code_coroutine(ng_u32 node_id, NgNode *node,
                                   ng_i32 node_idx, const char *src,
                                   size_t len) {
  int status;
  int nres = 0;
  lua_State *co;
  ng_i32 err = load_wrapped_code(g_lua, src, len);
  if (err != NG_OK) {
    const char *msg = lua_tostring(g_lua, -1);
    if (msg != NULL) {
      clear_io();
      append_io(msg, strlen(msg));
    }
    lua_settop(g_lua, 0);
    return err;
  }

  co = lua_newthread(g_lua);
  g_run.pending_co_ref = luaL_ref(g_lua, LUA_REGISTRYINDEX);
  g_run.pending_co = co;
  lua_xmove(g_lua, co, 1);

  push_node_inputs_table(co, node);
  lua_newtable(co);
  lua_pushcfunction(co, lua_host_await_call);
  lua_setfield(co, -2, "awaitCall");

  g_run.pending_node_id = node_id;
  status = lua_resume(co, NULL, 2, &nres);
  if (status == LUA_YIELD)
    return NG_ERR_HOST;
  if (status != LUA_OK) {
    const char *msg = lua_tostring(co, -1);
    if (msg != NULL) {
      clear_io();
      append_io(msg, strlen(msg));
    }
    return NG_ERR_RUNTIME;
  }
  err = capture_node_outputs(co, node, node_idx);
  lua_settop(co, 0);
  return err;
}

static ng_i32 resume_code_coroutine(NgNode *node, ng_i32 node_idx) {
  int status;
  int nres = 0;
  ng_i32 err = NG_OK;
  lua_State *co = g_run.pending_co;
  if (co == NULL)
    return NG_ERR_RUNTIME;
  lua_pushlstring(co, g_resp_buf, (size_t)g_run.response_len);
  status = lua_resume(co, NULL, 1, &nres);
  if (status == LUA_YIELD)
    return NG_ERR_HOST;
  if (status != LUA_OK) {
    const char *msg = lua_tostring(co, -1);
    if (msg != NULL) {
      clear_io();
      append_io(msg, strlen(msg));
    }
    return NG_ERR_RUNTIME;
  }
  err = capture_node_outputs(co, node, node_idx);
  lua_settop(co, 0);
  return err;
}

static void clear_pending_coroutine(void) {
  if (g_lua != NULL && g_run.pending_co_ref > 0) {
    luaL_unref(g_lua, LUA_REGISTRYINDEX, g_run.pending_co_ref);
  }
  g_run.pending_co_ref = LUA_NOREF;
  g_run.pending_co = NULL;
  g_run.pending_node_id = 0;
  g_run.pending_request_id = 0;
  g_run.has_response = 0;
  g_run.response_len = 0;
  clear_waiting();
}

static ng_i32 execute_node(ng_u32 node_id, ng_u8 *visit);

static ng_i32 execute_dependencies(NgNode *node, ng_u8 *visit) {
  ng_u32 i;
  for (i = 0; i < node->input_count; i++) {
    NgInputPort *in = &node->inputs[i];
    if (in->src_node_id != 0) {
      ng_i32 err = execute_node(in->src_node_id, visit);
      if (err != NG_OK)
        return err;
    }
  }
  return NG_OK;
}

static ng_i32 execute_node(ng_u32 node_id, ng_u8 *visit) {
  ng_i32 idx;
  NgNode *node;
  ng_i32 err;
  ng_i32 out_len;

  idx = find_node_index(node_id);
  if (idx < 0)
    return NG_ERR_NOT_FOUND;
  if (visit[idx] == 1)
    return NG_ERR_VALIDATION;
  if (visit[idx] == 2)
    return NG_OK;

  node = &g_info.nodes[idx];
  visit[idx] = 1;

  if (node->exec_state == NG_EXEC_SUCCESS) {
    visit[idx] = 2;
    return NG_OK;
  }

  err = execute_dependencies(node, visit);
  if (err != NG_OK) {
    node->exec_state = NG_EXEC_ERROR;
    node->last_error = err;
    notify_run_event(node->id, NG_RUN_EVENT_NODE_FAILED, err);
    visit[idx] = 2;
    return err;
  }

  notify_run_event(node->id, NG_RUN_EVENT_NODE_STARTED, NG_OK);
  if (node->kind == NG_NODE_CODE) {
    if (g_run.pending_node_id == node->id && g_run.has_response) {
      err = resume_code_coroutine(node, idx);
      if (err == NG_ERR_HOST) {
        visit[idx] = 2;
        return NG_ERR_HOST;
      }
      clear_pending_coroutine();
    } else {
      out_len = 0;
      err = ng_host_resolve(node->id, NG_RESOLVE_CODE, NULL, 0, g_code_buf,
                            NG_IO_BUFFER_CAP, &out_len);
      if (err != NG_OK || out_len < 0) {
        node->exec_state = NG_EXEC_ERROR;
        node->last_error = NG_ERR_HOST;
        notify_run_event(node->id, NG_RUN_EVENT_NODE_FAILED, NG_ERR_HOST);
        visit[idx] = 2;
        return NG_ERR_HOST;
      }
      err = start_code_coroutine(node->id, node, idx, g_code_buf,
                                 (size_t)out_len);
      if (err == NG_ERR_HOST) {
        visit[idx] = 2;
        return NG_ERR_HOST;
      }
    }
    if (err != NG_OK) {
      node->exec_state = NG_EXEC_ERROR;
      node->last_error = err;
      notify_run_event(node->id, NG_RUN_EVENT_NODE_FAILED, err);
      visit[idx] = 2;
      return err;
    }
  } else if (node->kind == NG_NODE_VALUE) {
    ng_u32 oi;
    clear_node_output_slots(idx);
    for (oi = 0; oi < node->output_count; oi++) {
      ng_u32 out_id = node->outputs[oi].id;
      char req[4];
      NgValueSlot slot;
      ng_i32 off;
      req[0] = (char)(out_id & 0xffu);
      req[1] = (char)((out_id >> 8) & 0xffu);
      req[2] = (char)((out_id >> 16) & 0xffu);
      req[3] = (char)((out_id >> 24) & 0xffu);
      out_len = 0;
      err = ng_host_resolve(node->id, NG_RESOLVE_VALUE, req, 4, g_code_buf,
                            NG_IO_BUFFER_CAP, &out_len);
      if (err != NG_OK || out_len < 0) {
        node->exec_state = NG_EXEC_ERROR;
        node->last_error = NG_ERR_HOST;
        notify_run_event(node->id, NG_RUN_EVENT_NODE_FAILED, NG_ERR_HOST);
        visit[idx] = 2;
        return NG_ERR_HOST;
      }
      memset(&slot, 0, sizeof(slot));
      if (out_len > 0) {
        off = value_alloc_and_copy(g_code_buf, out_len);
        if (off < 0) {
          node->exec_state = NG_EXEC_ERROR;
          node->last_error = NG_ERR_CAPACITY;
          notify_run_event(node->id, NG_RUN_EVENT_NODE_FAILED, NG_ERR_CAPACITY);
          visit[idx] = 2;
          return NG_ERR_CAPACITY;
        }
        slot.type = NG_VAL_STRING_REF;
        slot.a = off;
        slot.b = out_len;
      } else {
        slot.type = NG_VAL_EMPTY;
      }
      g_output_slots[idx][oi] = slot;
    }
  }

  node->exec_state = NG_EXEC_SUCCESS;
  node->last_error = NG_OK;
  notify_run_event(node->id, NG_RUN_EVENT_NODE_SUCCEEDED, NG_OK);
  visit[idx] = 2;
  return NG_OK;
}

ng_i32 ng_init(void) {
  memset(&g_info, 0, sizeof(g_info));
  memset(&g_run, 0, sizeof(g_run));
  g_run.pending_co_ref = LUA_NOREF;
  clear_value_store();
  if (init_lua() != NG_OK) {
    g_info.initialized = 0;
    set_last_error(NG_ERR_RUNTIME);
    return NG_ERR_RUNTIME;
  }
  g_info.initialized = 1;
  set_run_status(NG_RUN_IDLE);
  set_last_error(NG_OK);
  return NG_OK;
}

ng_i32 ng_get_info_ptr(void) { return (ng_i32)(intptr_t)&g_info; }

ng_i32 ng_clear_graph(void) {
  ng_i32 initialized = g_info.initialized;
  memset(g_info.nodes, 0, sizeof(g_info.nodes));
  g_info.node_count = 0;
  g_info.active_goal_count = 0;
  clear_pending_coroutine();
  memset(&g_run, 0, sizeof(g_run));
  g_run.pending_co_ref = LUA_NOREF;
  clear_value_store();
  clear_io();
  set_run_status(NG_RUN_IDLE);
  clear_waiting();
  g_info.generation += 1;
  g_info.initialized = initialized;
  set_last_error(NG_OK);
  notify_node_changed(0, NG_CHANGE_GRAPH);
  return NG_OK;
}

ng_i32 ng_node_create(ng_u32 node_id, ng_u32 kind) {
  NgNode *node;
  if (node_id == 0)
    return NG_ERR_INVALID_ARG;
  if (find_node(node_id) != NULL)
    return NG_ERR_VALIDATION;
  node = alloc_node_slot();
  if (node == NULL)
    return NG_ERR_CAPACITY;
  memset(node, 0, sizeof(*node));
  node->id = node_id;
  node->kind = kind;
  node->exec_state = NG_EXEC_NEVER;
  g_info.node_count += 1;
  refresh_active_goal_count();
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id, NG_CHANGE_NODE_META | NG_CHANGE_GRAPH);
  return NG_OK;
}

ng_i32 ng_node_replace(ng_u32 node_id, ng_u32 kind) {
  NgNode *node = find_node(node_id);
  ng_i32 node_idx = find_node_index(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  memset(node, 0, sizeof(*node));
  node->id = node_id;
  node->kind = kind;
  node->exec_state = NG_EXEC_NEVER;
  clear_node_output_slots(node_idx);
  refresh_active_goal_count();
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id, NG_CHANGE_NODE_META | NG_CHANGE_NODE_PORTS |
                                   NG_CHANGE_NODE_ARGS |
                                   NG_CHANGE_NODE_CONNECTIONS |
                                   NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

ng_i32 ng_node_delete(ng_u32 node_id) {
  ng_u32 i;
  ng_u32 j;
  ng_i32 node_idx = find_node_index(node_id);
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  memset(node, 0, sizeof(*node));
  clear_node_output_slots(node_idx);
  refresh_active_goal_count();
  if (g_info.node_count > 0)
    g_info.node_count -= 1;
  for (i = 0; i < NG_MAX_NODES; i++) {
    NgNode *n = &g_info.nodes[i];
    if (n->id == 0)
      continue;
    for (j = 0; j < n->input_count; j++) {
      if (n->inputs[j].src_node_id == node_id) {
        n->inputs[j].src_node_id = 0;
        n->inputs[j].src_output_id = 0;
        if (n->exec_state == NG_EXEC_SUCCESS)
          n->exec_state = NG_EXEC_STALE;
      }
    }
  }
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id, NG_CHANGE_GRAPH);
  return NG_OK;
}

ng_i32 ng_input_add(ng_u32 node_id, ng_u32 input_id) {
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  if (node->kind == NG_NODE_VALUE)
    return NG_ERR_VALIDATION;
  if (node->input_count >= NG_MAX_INPUTS)
    return NG_ERR_CAPACITY;
  if (find_input_index(node, input_id) >= 0)
    return NG_ERR_VALIDATION;
  node->inputs[node->input_count].id = input_id;
  node->inputs[node->input_count].src_node_id = 0;
  node->inputs[node->input_count].src_output_id = 0;
  node->input_count += 1;
  node->generation += 1;
  if (node->exec_state == NG_EXEC_SUCCESS)
    node->exec_state = NG_EXEC_STALE;
  mark_stale_downstream(node_id);
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id, NG_CHANGE_NODE_PORTS | NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

ng_i32 ng_input_remove(ng_u32 node_id, ng_u32 input_id) {
  ng_i32 idx;
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  idx = find_input_index(node, input_id);
  if (idx < 0)
    return NG_ERR_NOT_FOUND;
  if ((ng_u32)idx + 1 < node->input_count) {
    memmove(&node->inputs[idx], &node->inputs[idx + 1],
            (size_t)(node->input_count - ((ng_u32)idx + 1)) *
                sizeof(NgInputPort));
  }
  node->input_count -= 1;
  node->generation += 1;
  if (node->exec_state == NG_EXEC_SUCCESS)
    node->exec_state = NG_EXEC_STALE;
  mark_stale_downstream(node_id);
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id, NG_CHANGE_NODE_PORTS |
                                   NG_CHANGE_NODE_CONNECTIONS |
                                   NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

ng_i32 ng_output_add(ng_u32 node_id, ng_u32 output_id) {
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  if (node->kind == NG_NODE_GOAL)
    return NG_ERR_VALIDATION;
  if (node->output_count >= NG_MAX_OUTPUTS)
    return NG_ERR_CAPACITY;
  if (find_output_index(node, output_id) >= 0)
    return NG_ERR_VALIDATION;
  node->outputs[node->output_count].id = output_id;
  node->output_count += 1;
  node->generation += 1;
  if (node->exec_state == NG_EXEC_SUCCESS)
    node->exec_state = NG_EXEC_STALE;
  mark_stale_downstream(node_id);
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id, NG_CHANGE_NODE_PORTS | NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

ng_i32 ng_output_remove(ng_u32 node_id, ng_u32 output_id) {
  ng_i32 idx;
  ng_u32 i;
  ng_u32 j;
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  idx = find_output_index(node, output_id);
  if (idx < 0)
    return NG_ERR_NOT_FOUND;
  if ((ng_u32)idx + 1 < node->output_count) {
    memmove(&node->outputs[idx], &node->outputs[idx + 1],
            (size_t)(node->output_count - ((ng_u32)idx + 1)) *
                sizeof(NgOutputPort));
  }
  node->output_count -= 1;
  for (i = 0; i < NG_MAX_NODES; i++) {
    NgNode *n = &g_info.nodes[i];
    if (n->id == 0)
      continue;
    for (j = 0; j < n->input_count; j++) {
      if (n->inputs[j].src_node_id == node_id &&
          n->inputs[j].src_output_id == output_id) {
        n->inputs[j].src_node_id = 0;
        n->inputs[j].src_output_id = 0;
        if (n->exec_state == NG_EXEC_SUCCESS)
          n->exec_state = NG_EXEC_STALE;
      }
    }
  }
  node->generation += 1;
  if (node->exec_state == NG_EXEC_SUCCESS)
    node->exec_state = NG_EXEC_STALE;
  mark_stale_downstream(node_id);
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id, NG_CHANGE_NODE_PORTS |
                                   NG_CHANGE_NODE_CONNECTIONS |
                                   NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

ng_i32 ng_input_connect(ng_u32 node_id, ng_u32 input_id, ng_u32 src_node_id,
                        ng_u32 src_output_id) {
  ng_i32 in_idx;
  NgNode *node = find_node(node_id);
  NgNode *src = find_node(src_node_id);
  if (node == NULL || src == NULL)
    return NG_ERR_NOT_FOUND;
  in_idx = find_input_index(node, input_id);
  if (in_idx < 0)
    return NG_ERR_NOT_FOUND;
  if (find_output_index(src, src_output_id) < 0)
    return NG_ERR_NOT_FOUND;
  node->inputs[in_idx].src_node_id = src_node_id;
  node->inputs[in_idx].src_output_id = src_output_id;
  if (node->exec_state == NG_EXEC_SUCCESS)
    node->exec_state = NG_EXEC_STALE;
  mark_stale_downstream(node_id);
  node->generation += 1;
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id,
                      NG_CHANGE_NODE_CONNECTIONS | NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

ng_i32 ng_input_disconnect(ng_u32 node_id, ng_u32 input_id) {
  ng_i32 in_idx;
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  in_idx = find_input_index(node, input_id);
  if (in_idx < 0)
    return NG_ERR_NOT_FOUND;
  node->inputs[in_idx].src_node_id = 0;
  node->inputs[in_idx].src_output_id = 0;
  if (node->exec_state == NG_EXEC_SUCCESS)
    node->exec_state = NG_EXEC_STALE;
  mark_stale_downstream(node_id);
  node->generation += 1;
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id,
                      NG_CHANGE_NODE_CONNECTIONS | NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

ng_i32 ng_node_set_arg(ng_u32 node_id, ng_u32 arg_index, ng_u32 type, ng_i32 a,
                       ng_i32 b) {
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  if (arg_index >= NG_MAX_ARGS)
    return NG_ERR_INVALID_ARG;
  node->args[arg_index].type = type;
  node->args[arg_index].a = a;
  node->args[arg_index].b = b;
  if (arg_index + 1 > node->arg_count)
    node->arg_count = arg_index + 1;
  if (node->exec_state == NG_EXEC_SUCCESS)
    node->exec_state = NG_EXEC_STALE;
  mark_stale_downstream(node_id);
  node->generation += 1;
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id, NG_CHANGE_NODE_ARGS | NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

static ng_i32 execute_goal_with_fresh_visit(ng_u32 goal_node_id) {
  ng_u8 visit[NG_MAX_NODES];
  memset(visit, 0, sizeof(visit));
  return execute_node(goal_node_id, visit);
}

static ng_i32 continue_active_run(void) {
  ng_u32 i;
  ng_i32 err = NG_OK;
  if (!g_run.active)
    return NG_ERR_VALIDATION;
  if (g_run.cancelled) {
    set_run_status(NG_RUN_CANCELLED);
    g_run.active = 0;
    g_info.is_running = 0;
    return NG_ERR_RUNTIME;
  }

  if (g_run.target_goal_id != 0) {
    err = execute_goal_with_fresh_visit(g_run.target_goal_id);
    if (err == NG_ERR_HOST) {
      set_run_status(NG_RUN_WAITING);
      return NG_OK;
    }
    if (err != NG_OK) {
      set_run_status(NG_RUN_ERROR);
      g_run.active = 0;
      g_info.is_running = 0;
      notify_run_event(0, NG_RUN_EVENT_RUN_FINISHED, err);
      set_last_error(err);
      return err;
    }
    set_run_status(NG_RUN_DONE);
    g_run.active = 0;
    g_info.is_running = 0;
    notify_run_event(0, NG_RUN_EVENT_RUN_FINISHED, NG_OK);
    set_last_error(NG_OK);
    return NG_OK;
  }

  for (i = g_run.next_goal_scan; i < NG_MAX_NODES; i++) {
    NgNode *node = &g_info.nodes[i];
    if (node->id == 0 || node->kind != NG_NODE_GOAL)
      continue;
    g_run.next_goal_scan = i;
    err = execute_goal_with_fresh_visit(node->id);
    if (err == NG_ERR_HOST) {
      set_run_status(NG_RUN_WAITING);
      return NG_OK;
    }
    if (err != NG_OK) {
      set_run_status(NG_RUN_ERROR);
      g_run.active = 0;
      g_info.is_running = 0;
      notify_run_event(0, NG_RUN_EVENT_RUN_FINISHED, err);
      set_last_error(err);
      return err;
    }
    g_run.next_goal_scan = i + 1;
  }

  set_run_status(NG_RUN_DONE);
  g_run.active = 0;
  g_info.is_running = 0;
  notify_run_event(0, NG_RUN_EVENT_RUN_FINISHED, NG_OK);
  set_last_error(NG_OK);
  return NG_OK;
}

ng_i32 ng_run_start(ng_u32 goal_node_id) {
  NgNode *goal = NULL;
  if (!g_info.initialized)
    return NG_ERR_NOT_INITIALIZED;
  if (g_run.active)
    return NG_ERR_VALIDATION;
  if (goal_node_id != 0) {
    goal = find_node(goal_node_id);
    if (goal == NULL)
      return NG_ERR_NOT_FOUND;
    if (goal->kind != NG_NODE_GOAL)
      return NG_ERR_VALIDATION;
  }

  memset(&g_run, 0, sizeof(g_run));
  g_run.active = 1;
  g_run.target_goal_id = goal_node_id;
  g_run.next_goal_scan = 0;
  g_run.next_request_id = 0;
  g_run.pending_co_ref = LUA_NOREF;
  g_info.is_running = 1;
  set_run_status(NG_RUN_RUNNING);
  clear_waiting();
  notify_run_event(0, NG_RUN_EVENT_RUN_STARTED, NG_OK);
  return continue_active_run();
}

ng_i32 ng_run_response(ng_u32 request_id, ng_i32 json_ptr, ng_i32 json_len) {
  const char *src;
  if (!g_run.active)
    return NG_ERR_VALIDATION;
  if (g_info.run_status != NG_RUN_WAITING)
    return NG_ERR_VALIDATION;
  if (request_id == 0 || request_id != g_run.pending_request_id)
    return NG_ERR_NOT_FOUND;
  if (json_ptr == 0 || json_len < 0 || json_len >= NG_IO_BUFFER_CAP)
    return NG_ERR_INVALID_ARG;

  src = (const char *)(intptr_t)json_ptr;
  memcpy(g_resp_buf, src, (size_t)json_len);
  g_resp_buf[json_len] = '\0';
  g_run.response_len = json_len;
  g_run.has_response = 1;
  g_run.pending_request_id = 0;
  clear_waiting();
  set_run_status(NG_RUN_RUNNING);
  return continue_active_run();
}

ng_i32 ng_run_cancel(void) {
  if (!g_run.active)
    return NG_OK;
  g_run.cancelled = 1;
  clear_pending_coroutine();
  g_run.active = 0;
  g_info.is_running = 0;
  set_run_status(NG_RUN_CANCELLED);
  notify_run_event(0, NG_RUN_EVENT_RUN_FINISHED, NG_ERR_RUNTIME);
  set_last_error(NG_ERR_RUNTIME);
  return NG_OK;
}

ng_i32 ng_run_goal(ng_u32 goal_node_id) {
  ng_i32 err = ng_run_start(goal_node_id);
  if (err != NG_OK)
    return err;
  if (g_info.run_status == NG_RUN_WAITING)
    return NG_OK;
  g_info.is_running = 0;
  return g_info.last_error;
}

ng_i32 ng_run_all_goals(void) {
  ng_i32 err;
  refresh_active_goal_count();
  err = ng_run_start(0);
  if (err != NG_OK)
    return err;
  if (g_info.run_status == NG_RUN_WAITING)
    return NG_OK;
  g_info.is_running = 0;
  return g_info.last_error;
}

ng_i32 ng_exec_clear(ng_u32 node_id, ng_i32 recursive_downstream) {
  ng_u32 i;
  ng_u32 j;
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  node->exec_state = NG_EXEC_NEVER;
  node->last_error = NG_OK;
  if (recursive_downstream) {
    for (i = 0; i < NG_MAX_NODES; i++) {
      NgNode *n = &g_info.nodes[i];
      if (n->id == 0 || n->id == node_id)
        continue;
      for (j = 0; j < n->input_count; j++) {
        if (n->inputs[j].src_node_id == node_id) {
          ng_exec_clear(n->id, 1);
          break;
        }
      }
    }
  }
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(node_id, NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

ng_i32 ng_exec_clear_all(void) {
  ng_u32 i;
  clear_pending_coroutine();
  g_run.active = 0;
  g_info.is_running = 0;
  set_run_status(NG_RUN_IDLE);
  clear_waiting();
  for (i = 0; i < NG_MAX_NODES; i++) {
    if (g_info.nodes[i].id != 0) {
      g_info.nodes[i].exec_state = NG_EXEC_NEVER;
      g_info.nodes[i].last_error = NG_OK;
    }
  }
  clear_value_store();
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(0, NG_CHANGE_NODE_EXEC | NG_CHANGE_GRAPH);
  return NG_OK;
}

ng_i32 ng_get_last_error(void) { return g_info.last_error; }

ng_i32 ng_get_io_ptr(void) { return (ng_i32)(intptr_t)g_info.io_buf; }

ng_i32 ng_get_io_len(void) { return g_info.io_len; }

ng_i32 ng_get_node_exec_state(ng_u32 node_id) {
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return -1;
  return (ng_i32)node->exec_state;
}

int main(void) { return 0; }
