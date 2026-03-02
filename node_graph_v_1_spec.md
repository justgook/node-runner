# NodeGraph Product v1 - API, ABI, and Protocol Spec

## Product Goal
Build this project into a production-grade node graph editor platform (n8n/Unreal/Blender style):

- Visual graph authoring
- Headless graph execution
- Stable host integration boundary (WASM + native)
- Pluggable node types and executors

This document is the source of truth for v1 interfaces. Implementation follows only after spec freeze.

Supporting design decisions are tracked in ADRs under `docs/adr/`.

## Spec-First Rule

For this repository, the order is strict:

1. Lock API/ABI/protocol and versioning rules
2. Review and freeze v1 spec
3. Implement against the frozen spec

No runtime behavior is considered stable unless documented here.

## Current Status

- Existing Lua-in-WASM code is a proof of concept only
- POC behavior is non-normative for v1
- v1 contracts are defined by this file, not by current implementation details

---

## Architecture Boundaries

Backend and frontend are separated intentionally.

**Backend**
- `graph-state`: deterministic state + command reducer
- `graph-runner`: execution orchestration + runtime events
- `host-abi`: C/WASM boundary for host integration

**Frontend**
- Rendering, interactions, editor UX
- Must only mutate graph via commands
- Must only react to runtime via events/snapshots

---

## Versioning

- Every top-level payload includes `version`
- v1 payloads use `"version": 1`
- Breaking changes require v2 namespace or capability flag gating

---

## Canonical State ABI

## CoreGraphState

```json
{
  "version": 1,
  "graph": {
    "id": "graph_main",
    "nodes": {},
    "edges": [],
    "order": []
  },
  "runtime": {
    "isExecuting": false,
    "nodes": {},
    "lastRunId": null
  }
}
```

### State Invariants
- All edge endpoints reference existing `nodeId` and valid ports
- Node IDs and edge IDs are stable, unique strings
- Reducers are pure and deterministic
- Runtime section is derived from runner events, not direct UI mutation

---

## Node ABI

```json
{
  "id": "node_1",
  "type": "plugin.example",
  "title": "Example",
  "present": { "x": 0, "y": 0, "width": 220, "height": 140, "z": 1 },
  "ports": {
    "inputs": [],
    "outputs": []
  },
  "attrs": {},
  "capabilities": {
    "runnable": true,
    "editable": true,
    "deletable": true
  }
}
```

`present` is editor layout metadata, not execution semantics.

---

## Edge ABI

```json
{
  "id": "edge_1",
  "from": { "nodeId": "node_1", "port": "out" },
  "to": { "nodeId": "node_2", "port": "in" }
}
```

---

## Runtime Node Record ABI

```json
{
  "state": "idle",
  "isExecuting": false,
  "error": null,
  "outputs": {},
  "execution": {
    "runId": null,
    "startedAt": 0,
    "endedAt": 0
  }
}
```

Allowed `state`: `idle | queued | running | succeeded | failed | cancelled`.

---

## Command Protocol

Direction for v1 is controlled by ADR-0001: prefer explicit operations over open command namespaces.

## Operation Envelope (draft)

```json
{
  "version": 1,
  "id": "op_1",
  "op": "node_create",
  "payload": {},
  "meta": { "ts": 0, "source": "ui" }
}
```

### Reducer Rules
- Operation dispatch is the only mutation path for canonical graph state
- Invalid operation returns structured error and applies no mutation
- Reducer execution is synchronous and side-effect free

### Minimum v1 Operation Set (draft)
- `graph_import`
- `node_create`
- `node_update_meta`
- `node_set_attr`
- `node_delete`
- `edge_create`
- `edge_delete`
- `run_graph`
- `run_node`
- `cancel_run`

Each operation gets a strict payload schema and validation/error contract.

---

## Runner Protocol

## Runner Methods (Logical)
- `runGraph(options?)`
- `runNode(nodeId, options?)`
- `cancelRun(runId?)`

## RunnerEvent Envelope

```json
{
  "version": 1,
  "type": "node.started",
  "runId": "run_1",
  "nodeId": "node_7",
  "ts": 0,
  "payload": {}
}
```

### Event Types (v1)
- `run.started`
- `node.queued`
- `node.started`
- `node.succeeded`
- `node.failed`
- `run.finished`
- `run.cancelled`

Runner never mutates graph state directly. It emits events; host/state layer applies updates.

---

## Executor Contract

```js
async function executeNode(ctx) {
  return { outputs: {} };
}
```

`ctx` must include at least:
- `node`
- `inputs`
- `attrs`
- `signal` (cancellation)
- `run` metadata (`runId`, timestamps)

---

## Host/WASM ABI (Planned v1)

This is the ABI to codify in `src/node-runner.h` after spec freeze.

## Host -> WASM Exports

```c
void ng_dispatch_command(const char* json, int length);
void ng_load_state(const char* json, int length);
void ng_run_graph(const char* options_json, int length);
void ng_run_node(const char* node_id, int length);
void ng_cancel_run(const char* run_id, int length);
```

## WASM -> Host Imports

```c
void ng_on_state_changed(const char* json, int length);
void ng_on_runner_event(const char* json, int length);
void ng_on_diagnostics(const char* json, int length);
```

### ABI Rules
- UTF-8 JSON transport in v1
- Caller owns input memory
- Callee copies inputs it needs beyond call scope
- Functions must be safe on invalid payload (return diagnostics, no crash)

---

## Public Header Policy (Planned)

`src/node-runner.h` is the single public C API contract when introduced.

Requirements:
- Contains all exported symbols intended for host usage
- Contains stable typedefs, enums, and ABI-level constants
- Is sufficient for integration without source access
- Changes are versioned and documented in this spec

---

## Non-Goals for v1

- CRDT/collaborative merge logic
- Binary protocol transport
- Distributed runner scheduling
- GUI framework lock-in

---

## v1 Freeze Checklist

- Command namespace and payload schemas finalized
- Runner event set and ordering guarantees documented
- Host/WASM ABI signatures finalized
- Error model and diagnostics schema finalized
- Public header layout (`src/node-runner.h`) approved

When this checklist is complete, implementation can start.

---

## Future Extensions

- Binary ABI transport
- Remote runner protocol
- Streaming node outputs
- Multi-user collaboration
