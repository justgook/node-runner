# Async code-node execution model (Lua in WASM, host-driven I/O)

Target behavior:

- `code` node scripts are authored as body-only Lua.
- WASM wraps the body into `function(inputs, host) -> outputs`.
- Script calls `host.awaitCall(service, method, payloadJson)`.
- Lua appears synchronous to author, but runtime is cooperative async.
- Host (browser) performs async work and later delivers response JSON back to WASM.

## 1) Authoring and wrapper

Author writes body only:

```lua
local respJson = host.awaitCall("http", "post", inputs.request)
print(respJson)
```

WASM executes generated chunk:

```lua
return function(inputs, host)
  local outputs = {}
  -- user body
  return outputs
end
```

## 2) Ownership model

- Code text is host-owned (UI/backend map), not stored as raw source in WASM.
- WASM requests code through `ng_host_resolve(..., NG_RESOLVE_CODE, ...)`.
- This keeps the same model for browser UI and headless hosts.

## 3) Async run API (single active run in v1)

- `ng_run_start(goalNodeId)`
  - `goalNodeId == 0` means run all goals.
  - Runs until done, error, or wait-on-host.
- `ng_run_response(requestId, jsonPtr, jsonLen)`
  - Delivers response payload for pending `host.awaitCall`.
  - Runtime resumes from await point.
- `ng_run_cancel()`
  - Cancels current run and clears pending wait.

No `runId` in v1 (single active run only).

## 4) Request/response protocol

Lua API exposed to scripts:

- `host.awaitCall(service, method, payloadJson)`

When called:

1. Runtime allocates `requestId`.
2. Runtime imports into host via:
   - `ng_host_request(nodeId, requestId, service, method, payloadJson)`.
3. Lua coroutine yields.
4. Host performs async work.
5. Host calls `ng_run_response(requestId, responseJson)`.
6. Runtime resumes coroutine, and `awaitCall` returns `responseJson` to Lua.

Error handling policy:

- No NG-specific response error channel for await results.
- Host always returns JSON payload.
- Error semantics are part of JSON and handled by code writer.

## 5) Shared state (in `NgInfo`)

Runtime publishes:

- `run_status` (`IDLE|RUNNING|WAITING|DONE|ERROR|CANCELLED`)
- `waiting_request_id`
- `waiting_node_id`

UI/host can observe run status directly from shared memory.

## 6) Current scope vs next scope

Implemented scope:

- Wrapper-based code execution.
- `host.awaitCall(service, method, payloadJson)` host boundary.
- Single-run API surface (`ng_run_start`, `ng_run_response`, `ng_run_cancel`) in place.
- Value/code host-resolve plumbing (`NG_RESOLVE_VALUE`, `NG_RESOLVE_CODE`, `NG_RESOLVE_CALL`).

Current runtime note:

- `awaitCall` currently executes via host resolve path (sync at C boundary).
- Browser host path performs real HTTP request at call time (same-origin), so Lua script stays linear/synchronous from author perspective.
- Full coroutine yield/resume async behavior remains target behavior and requires replacing current WASM setjmp/longjmp shim constraints.

Next scope:

- Strongly typed inputs/outputs (`NgValueSlot` mapping).
- Value-node host resolution (`NG_RESOLVE_VALUE`) and downstream propagation.
- Optional multi-run (`runId`) support.
- Optional richer await payload protocol (binary/tags beyond JSON string).
