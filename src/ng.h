#ifndef NG_H
#define NG_H

#if defined(_MSC_VER)
typedef signed __int32 ng_i32;
typedef unsigned __int32 ng_u32;
typedef unsigned __int8 ng_u8;
#else
typedef __INT32_TYPE__ ng_i32;
typedef __UINT32_TYPE__ ng_u32;
typedef __UINT8_TYPE__ ng_u8;
#endif

#if defined(__wasm__)
#define NG_EXPORT(name) __attribute__((export_name(name)))
#else
#define NG_EXPORT(name)
#endif

/* ---- Capacity constants ---------------------------------------------- */

#define NG_MAX_NODES 1024
#define NG_MAX_INPUTS 32
#define NG_MAX_OUTPUTS 32
#define NG_MAX_ARGS 32
#define NG_IO_BUFFER_CAP 65536

/* ---- Error codes ------------------------------------------------------ */

enum ng_error {
  NG_OK = 0,
  NG_ERR_NOT_INITIALIZED = 1,
  NG_ERR_INVALID_ARG = 2,
  NG_ERR_NOT_FOUND = 3,
  NG_ERR_CAPACITY = 4,
  NG_ERR_VALIDATION = 5,
  NG_ERR_RUNTIME = 6,
  NG_ERR_HOST = 7,
};

/* ---- Node kinds (v1 baseline) ---------------------------------------- */

enum ng_node_kind {
  NG_NODE_GOAL = 1,
  NG_NODE_CODE = 2,
  NG_NODE_CALL = 3,
  NG_NODE_VALUE = 4,
};

/* ---- Runtime execution state ----------------------------------------- */

enum ng_exec_state {
  NG_EXEC_NEVER = 0,
  NG_EXEC_SUCCESS = 1,
  NG_EXEC_ERROR = 2,
  NG_EXEC_STALE = 3,
};

/* ---- Host resolve kinds ---------------------------------------------- */

enum ng_resolve_kind {
  NG_RESOLVE_CODE = 1,
  NG_RESOLVE_CALL = 2,
  NG_RESOLVE_VALUE = 3,
};

/* ---- Host callback enums ---------------------------------------------- */

enum ng_change_mask {
  NG_CHANGE_NODE_META = (1u << 0),
  NG_CHANGE_NODE_PORTS = (1u << 1),
  NG_CHANGE_NODE_ARGS = (1u << 2),
  NG_CHANGE_NODE_CONNECTIONS = (1u << 3),
  NG_CHANGE_NODE_EXEC = (1u << 4),
  NG_CHANGE_GRAPH = (1u << 5),
};

enum ng_run_event_kind {
  NG_RUN_EVENT_RUN_STARTED = 1,
  NG_RUN_EVENT_NODE_STARTED = 2,
  NG_RUN_EVENT_NODE_SUCCEEDED = 3,
  NG_RUN_EVENT_NODE_FAILED = 4,
  NG_RUN_EVENT_RUN_FINISHED = 5,
};

/* ---- Value slot ------------------------------------------------------- */

enum ng_value_type {
  NG_VAL_EMPTY = 0,
  NG_VAL_I64 = 1,
  NG_VAL_F64 = 2,
  NG_VAL_BOOL = 3,
  NG_VAL_BYTES_REF = 4,
  NG_VAL_STRING_REF = 5,
};

typedef struct {
  ng_u32 type; /* enum ng_value_type */
  ng_i32 a;    /* payload part A (see encoding rules below) */
  ng_i32 b;    /* payload part B (see encoding rules below) */
} NgValueSlot;

/* NgValueSlot encoding rules (v1):
 * - NG_VAL_EMPTY: a=0, b=0
 * - NG_VAL_BOOL: a=0|1, b=0
 * - NG_VAL_I64: low 32 bits in a, high 32 bits in b
 * - NG_VAL_F64: IEEE-754 bits split as low 32 bits in a, high 32 bits in b
 * - NG_VAL_BYTES_REF: a=offset in NgInfo.io_buf, b=byte length
 * - NG_VAL_STRING_REF: a=offset in NgInfo.io_buf, b=byte length (UTF-8)
 */

/* ---- Ports ------------------------------------------------------------ */

typedef struct {
  ng_u32 id;
  ng_u32 src_node_id;   /* 0 means disconnected */
  ng_u32 src_output_id; /* valid when src_node_id != 0 */
} NgInputPort;

typedef struct {
  ng_u32 id;
} NgOutputPort;

/* ---- Node record ------------------------------------------------------ */

typedef struct {
  ng_u32 id;
  ng_u32 kind;       /* enum ng_node_kind */
  ng_u32 exec_state; /* enum ng_exec_state */

  ng_i32 last_error;
  ng_u32 generation;

  ng_u32 input_count;
  ng_u32 output_count;
  ng_u32 arg_count;

  NgInputPort inputs[NG_MAX_INPUTS];
  NgOutputPort outputs[NG_MAX_OUTPUTS];
  NgValueSlot args[NG_MAX_ARGS];
} NgNode;

/* ---- Shared state blob ------------------------------------------------ */

typedef struct {
  ng_i32 initialized;
  ng_i32 last_error;
  ng_u32 generation;

  ng_u32 node_count;
  ng_i32 is_running;
  ng_u32 active_goal_count;

  ng_i32 io_len;
  NgNode nodes[NG_MAX_NODES];

  char io_buf[NG_IO_BUFFER_CAP];

} NgInfo;

/* ---- API -------------------------------------------------------------- */

NG_EXPORT("ng_init")
ng_i32 ng_init(void);

NG_EXPORT("ng_get_info_ptr")
ng_i32 ng_get_info_ptr(void);

/* graph lifecycle */
NG_EXPORT("ng_clear_graph")
ng_i32 ng_clear_graph(void);

/* node lifecycle */
NG_EXPORT("ng_node_create")
ng_i32 ng_node_create(ng_u32 node_id, ng_u32 kind);

/* full replace while keeping node id */
NG_EXPORT("ng_node_replace")
ng_i32 ng_node_replace(ng_u32 node_id, ng_u32 kind);

NG_EXPORT("ng_node_delete")
ng_i32 ng_node_delete(ng_u32 node_id);

/* dynamic ports */
NG_EXPORT("ng_input_add")
ng_i32 ng_input_add(ng_u32 node_id, ng_u32 input_id);

NG_EXPORT("ng_input_remove")
ng_i32 ng_input_remove(ng_u32 node_id, ng_u32 input_id);

NG_EXPORT("ng_output_add")
ng_i32 ng_output_add(ng_u32 node_id, ng_u32 output_id);

NG_EXPORT("ng_output_remove")
ng_i32 ng_output_remove(ng_u32 node_id, ng_u32 output_id);

/* one input can have only one source */
NG_EXPORT("ng_input_connect")
ng_i32 ng_input_connect(ng_u32 node_id, ng_u32 input_id, ng_u32 src_node_id,
                        ng_u32 src_output_id);

NG_EXPORT("ng_input_disconnect")
ng_i32 ng_input_disconnect(ng_u32 node_id, ng_u32 input_id);

/* node args */
NG_EXPORT("ng_node_set_arg")
ng_i32 ng_node_set_arg(ng_u32 node_id, ng_u32 arg_index, ng_u32 type, ng_i32 a,
                       ng_i32 b);

/* goals + execution */
NG_EXPORT("ng_run_all_goals")
ng_i32 ng_run_all_goals(void);

NG_EXPORT("ng_run_goal")
ng_i32 ng_run_goal(ng_u32 goal_node_id);

/* clear execution state for a node and (optionally) downstream nodes */
NG_EXPORT("ng_exec_clear")
ng_i32 ng_exec_clear(ng_u32 node_id, ng_i32 recursive_downstream);

NG_EXPORT("ng_exec_clear_all")
ng_i32 ng_exec_clear_all(void);

NG_EXPORT("ng_get_last_error")
ng_i32 ng_get_last_error(void);

NG_EXPORT("ng_get_io_ptr")
ng_i32 ng_get_io_ptr(void);

NG_EXPORT("ng_get_io_len")
ng_i32 ng_get_io_len(void);

NG_EXPORT("ng_get_node_exec_state")
ng_i32 ng_get_node_exec_state(ng_u32 node_id);

/* ---- Host imports (implemented by host) ------------------------------ */

/* compact event callbacks, no JSON */
void ng_on_node_changed(ng_u32 node_id, ng_u32 change_mask);
void ng_on_run_event(ng_u32 node_id, ng_u32 event_kind, ng_i32 error_code);

/* lazy resolver for code/call/value data
 * - req_ptr/req_len is an opaque byte request (format defined by resolve_kind)
 * - out_ptr/out_cap receives opaque bytes to be interpreted by node runtime
 */
ng_i32 ng_host_resolve(ng_u32 node_id, ng_u32 resolve_kind, const char *req_ptr,
                       ng_i32 req_len, char *out_ptr, ng_i32 out_cap,
                       ng_i32 *out_len);

#undef NG_EXPORT

#endif /* NG_H */
