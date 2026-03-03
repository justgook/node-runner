#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "ng.h"
#include "./vendor/lua/lauxlib.h"
#include "./vendor/lua/lualib.h"

static NgInfo g_info;
static lua_State *g_lua = NULL;
static char g_code_buf[NG_IO_BUFFER_CAP];

static void set_last_error(ng_i32 err) {
  g_info.last_error = err;
}

static void notify_node_changed(ng_u32 node_id, ng_u32 change_mask) {
  ng_on_node_changed(node_id, change_mask);
}

static void notify_run_event(ng_u32 node_id, ng_u32 event_kind, ng_i32 error_code) {
  ng_on_run_event(node_id, event_kind, error_code);
}

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

static ng_i32 run_lua_source(const char *src, size_t len) {
  int status;
  if (g_lua == NULL)
    return NG_ERR_NOT_INITIALIZED;
  clear_io();
  status = luaL_loadbufferx(g_lua, src, len, "node-code", "t");
  if (status == LUA_OK)
    status = lua_pcall(g_lua, 0, LUA_MULTRET, 0);
  if (status != LUA_OK) {
    const char *err = lua_tostring(g_lua, -1);
    clear_io();
    if (err != NULL)
      append_io(err, strlen(err));
    lua_pop(g_lua, 1);
    return NG_ERR_RUNTIME;
  }
  return NG_OK;
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
    err = run_lua_source(g_code_buf, (size_t)out_len);
    if (err != NG_OK) {
      node->exec_state = NG_EXEC_ERROR;
      node->last_error = err;
      notify_run_event(node->id, NG_RUN_EVENT_NODE_FAILED, err);
      visit[idx] = 2;
      return err;
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
  if (init_lua() != NG_OK) {
    g_info.initialized = 0;
    set_last_error(NG_ERR_RUNTIME);
    return NG_ERR_RUNTIME;
  }
  g_info.initialized = 1;
  set_last_error(NG_OK);
  return NG_OK;
}

ng_i32 ng_get_info_ptr(void) {
  return (ng_i32)(intptr_t)&g_info;
}

ng_i32 ng_clear_graph(void) {
  ng_i32 initialized = g_info.initialized;
  memset(g_info.nodes, 0, sizeof(g_info.nodes));
  g_info.node_count = 0;
  g_info.active_goal_count = 0;
  clear_io();
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
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  memset(node, 0, sizeof(*node));
  node->id = node_id;
  node->kind = kind;
  node->exec_state = NG_EXEC_NEVER;
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
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
  memset(node, 0, sizeof(*node));
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
  notify_node_changed(node_id,
                      NG_CHANGE_NODE_PORTS | NG_CHANGE_NODE_CONNECTIONS |
                          NG_CHANGE_NODE_EXEC);
  return NG_OK;
}

ng_i32 ng_output_add(ng_u32 node_id, ng_u32 output_id) {
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return NG_ERR_NOT_FOUND;
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
  notify_node_changed(node_id,
                      NG_CHANGE_NODE_PORTS | NG_CHANGE_NODE_CONNECTIONS |
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
  notify_node_changed(node_id, NG_CHANGE_NODE_CONNECTIONS | NG_CHANGE_NODE_EXEC);
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
  notify_node_changed(node_id, NG_CHANGE_NODE_CONNECTIONS | NG_CHANGE_NODE_EXEC);
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

ng_i32 ng_run_goal(ng_u32 goal_node_id) {
  ng_i32 err;
  ng_u8 visit[NG_MAX_NODES];
  NgNode *goal = find_node(goal_node_id);
  if (goal == NULL)
    return NG_ERR_NOT_FOUND;
  if (goal->kind != NG_NODE_GOAL)
    return NG_ERR_VALIDATION;
  memset(visit, 0, sizeof(visit));
  g_info.is_running = 1;
  notify_run_event(0, NG_RUN_EVENT_RUN_STARTED, NG_OK);
  err = execute_node(goal_node_id, visit);
  g_info.is_running = 0;
  notify_run_event(0, NG_RUN_EVENT_RUN_FINISHED, err);
  set_last_error(err);
  return err;
}

ng_i32 ng_run_all_goals(void) {
  ng_u32 i;
  NgNode *node;
  ng_i32 err = NG_OK;
  ng_u8 visit[NG_MAX_NODES];
  refresh_active_goal_count();
  memset(visit, 0, sizeof(visit));
  g_info.is_running = 1;
  notify_run_event(0, NG_RUN_EVENT_RUN_STARTED, NG_OK);
  for (i = 0; i < NG_MAX_NODES; i++) {
    node = &g_info.nodes[i];
    if (node->id == 0)
      continue;
    if (node->kind != NG_NODE_GOAL)
      continue;
    err = execute_node(node->id, visit);
    if (err != NG_OK)
      break;
  }
  g_info.is_running = 0;
  notify_run_event(0, NG_RUN_EVENT_RUN_FINISHED, err);
  set_last_error(err);
  return err;
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
  for (i = 0; i < NG_MAX_NODES; i++) {
    if (g_info.nodes[i].id != 0) {
      g_info.nodes[i].exec_state = NG_EXEC_NEVER;
      g_info.nodes[i].last_error = NG_OK;
    }
  }
  g_info.generation += 1;
  set_last_error(NG_OK);
  notify_node_changed(0, NG_CHANGE_NODE_EXEC | NG_CHANGE_GRAPH);
  return NG_OK;
}

ng_i32 ng_get_last_error(void) {
  return g_info.last_error;
}

ng_i32 ng_get_io_ptr(void) {
  return (ng_i32)(intptr_t)g_info.io_buf;
}

ng_i32 ng_get_io_len(void) {
  return g_info.io_len;
}

ng_i32 ng_get_node_exec_state(ng_u32 node_id) {
  NgNode *node = find_node(node_id);
  if (node == NULL)
    return -1;
  return (ng_i32)node->exec_state;
}

int main(void) { return 0; }
