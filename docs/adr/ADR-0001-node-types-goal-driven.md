# ADR-0001: Node types for goal-driven execution

- Status: proposed
- Date: 2026-03-02
- Deciders: project maintainers

## Context

The product is a node editor for building pipelines where execution is driven by selected target outcomes.

v1 needs a minimal, explicit node type set before API/ABI details are finalized.

## Decision

v1 adopts a goal-driven model with these base node types:

1. `node-goal`
   - Marks a required outcome for the run
   - Run starts from one or more selected goal nodes

2. `node-code`
   - Executes Lua code
   - Produces outputs from resolved inputs

3. `node-call`
   - Calls host-provided functionality
   - Host response becomes node outputs

4. `node-value`
   - Provides constant/provided data
   - May support typed values and raw byte payload variants

## Execution implications

- Planner resolves dependencies from selected `node-goal` nodes backward
- Dependencies execute before dependents
- v1 is sequential execution only (no parallel scheduler)
- Node results are cached and reused between runs

## Runtime caching rule (agreed baseline)

Node executes only when state is one of:

- `never_run`
- `error`
- `stale`

`stale` must be set when node definition/input bindings/attrs change, and propagated to downstream dependents.

## Deferred / open question

`flow` category (if/switch/merge/skip) is intentionally deferred from v1 base types.

Rationale:

- Branching can be encoded in `node-code` initially
- Explicit skip/ignore semantics introduce additional runtime states and policy complexity

Open question to revisit in later ADR:

- Should v2 add explicit flow-control nodes with branch skipping semantics?

## Consequences

Positive:

- Minimal type system to start building stable API/ABI
- Direct alignment with current Lua + host-call goals
- Clear path to incremental extension

Tradeoffs:

- Complex branching UX is postponed
- Some workflows may require custom Lua logic where dedicated flow nodes would be clearer
