# ADR-0002: Host/WASM shared-state ABI with fixed-size records

- Status: proposed
- Date: 2026-03-02
- Deciders: project maintainers

## Context

The project wants a simple integration model similar to `src/example.h`:

- One shared in-memory state blob
- Host reads state directly from known struct layout
- No JSON transport for core mutations/events

## Decision

Use a fixed-layout C ABI centered on `NgInfo` returned by `ng_get_info_ptr()`.

Key choices:

- Fixed capacities in header (`NG_MAX_NODES`, `NG_MAX_INPUTS`, `NG_MAX_OUTPUTS`)
- Input-owned connections (`src_node_id`, `src_output_id` on each input)
- Explicit function operations (no generic command JSON bus)
- Compact host callbacks (`ng_on_node_changed`, `ng_on_run_event`)
- Single lazy host resolver (`ng_host_resolve`) for code/call/value runtime data

Enum baseline added in `src/ng.h`:

- `ng_change_mask`: node metadata/ports/args/connections/execution/graph mutation flags
- `ng_run_event_kind`: run started, node started/succeeded/failed, run finished

Value encoding baseline added in `src/ng.h`:

- `NgValueSlot` is fixed-width `(type, a, b)`
- `i64` and `f64` use low32->`a`, high32->`b`
- refs use `(offset, len)` into `NgInfo.io_buf`

ABI policy for v1:

- No reserved fields in structs; every field must have active v1 meaning

## API simplifications

- Remove `ng_load_state`
- Remove `ng_get_state_len`
- Merge reset/invalidate into `ng_exec_clear`

## Consequences

Positive:

- Low-overhead host integration
- O(1) node lookup and predictable memory layout
- Easier to debug in WASM memory tools

Tradeoffs:

- Fixed capacities impose hard limits
- ABI evolution requires careful versioning and struct compatibility strategy

## Follow-up

- Define stable node slot policy (dense vs sparse array)
- Define per-`resolve_kind` request/response byte schemas for `ng_host_resolve`
