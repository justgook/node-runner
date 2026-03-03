Status key: [x] done, [~] partial, [ ] todo

1) Foundation: wasm-first graph model (headless-capable)
   - 1.1 Define wasm graph API contract (authoritative state)
      - [~] Node CRUD (id, kind, title, position, z-index/layer)
      - [~] Port metadata (name, direction, data type, flags)
      - [~] Edge CRUD (fromNode/fromPort -> toNode/toPort)
      - [~] Arg/value contract using NgValueSlot (typed a/b payload + io_buf refs)
      - [ ] Selection state (optional in wasm, recommended for deterministic behavior)
   - 1.2 Generation/versioning model
     - [x] Increment generation on every mutation
     - [x] Expose minimal read APIs for renderer snapshots
   - 1.3 Validation in wasm
     - [~] Prevent invalid links (input->input, output->output, self-loop if disallowed)
     - [~] Enforce single-input connection / multi-output fan-out rules
   - 1.4 Headless execution parity
     - [x] Graph run and per-node run work without UI
     - [x] Execution state available in read API for renderer

2) Render assets + visual system (WebGL)
   - 2.1 Clean node-graph-assets.js schema
     - [x] Remove unused/outdated props
     - [x] Split into: theme, layout, ports, text, edge, nineSlice
   - 2.2 Port visuals
     - [x] Add assets/port-full.png and assets/port-empty.png
     - [~] Define icon size, spacing, label offsets, hit radius, hover ring radius
   - 2.3 Node visuals
     - [x] Define node body/header dimensions and padding
     - [x] Title/secondary text sizes and colors
     - [ ] Selection outline style
   - 2.4 Edge visuals
     - [~] Normal/active/valid/invalid colors
     - [x] Thickness/glow/AA values
   - 2.5 Text rendering rules
     - [~] Title font size, port font size, truncation + ellipsis
     - [ ] Value/type badge styling (phase 2)

3) WebGL rendering implementation
   - 3.1 Extend render passes
     - [~] Background -> edges -> nodes -> ports -> labels -> overlays
   - 3.2 Port sprite texture loading and drawing
     - [x] Atlas/standalone texture upload
     - [~] Input/output and state variants (connected/empty/hover)
   - 3.3 Port-aware edge anchoring
     - [x] Anchor by actual port index + configured spacing
   - 3.4 Visual state mapping
     - [~] Map wasm exec/selection/hover states to colors/icons

4) Interaction + picking (WebGL + wasm mutations)
   - 4.1 Picking primitives
     - [x] Node hit-test
     - [x] Port hit-test with configurable hit radius
     - [x] Edge hit-test (curve distance threshold)
   - 4.2 Selection behavior
     - [x] Single select, Ctrl/Cmd multiselect, clear-on-empty
   - 4.3 Node drag
     - [x] Drag selected node(s), commit positions to frontend layout map
     - [ ] Optional front-priority/z-index update
   - 4.4 Connection editing
     - [x] Drag from port to create edge
     - [x] Reconnect by dragging existing edge endpoint
     - [x] Drop on empty to disconnect (for reconnect flow)
   - 4.5 Camera controls
     - [~] Pan, zoom-at-cursor, fit-to-content

5) Editing + execution UX (high priority)
   - 5.1 Node editing
      - [ ] Edit node payload/args (form + validation + apply/cancel)
      - [ ] Edit node title/kind where allowed by schema
      - [ ] Delete selected node(s)
   - 5.2 Code/data interactions (inputs/outputs)
     - [ ] Define per-port binding model (constant | edge | computed/default)
     - [ ] Input editor by type (string/number/bool/json/code ref)
     - [ ] Output preview panel (value/error/stale/loading)
     - [ ] Validation feedback on incompatible type/link/binding
   - 5.3 Execution UX (graph-level)
      - [ ] Run graph / stop / rerun graph
      - [ ] Node execution state visualization (idle/running/success/error/stale)
      - [ ] Error surfacing: node-level error + graph run summary
   - 5.4 Node-type editor contracts (align with ng.h)
      - [ ] VALUE node: outputs editor + arg[0]=value_index/value_id (NgValueSlot), host resolves NG_RESOLVE_VALUE
      - [ ] CODE node: inputs/outputs editor + arg[0]=code_value_id (NgValueSlot), host resolves NG_RESOLVE_CODE
      - [ ] GOAL node: inputs editor only (no custom outputs required)
      - [ ] Keep stable input_id/output_id during rename/reorder to avoid edge churn
   - 5.5 NgValueSlot UX mapping
      - [ ] Support NG_VAL_EMPTY/BOOL/I64/F64/STRING_REF in editor widgets
      - [ ] Define policy for BYTES_REF and UTF-8 STRING_REF via io_buf
      - [ ] Validate arg index usage per node kind (reserved slots, bounds, type checks)

6) Persistence + tooling (last phase, split backend/UI)
   - [ ] 6.1 Backend/model persistence contract
         (wasm serialize/deserialize + versioning/migrations)
   - [ ] 6.2 UI persistence pipeline
         (save/load/reload wiring; include non-wasm UI state policy)
   - [ ] 6.3 Template/node creation workflow
   - [ ] 6.4 Optional node attribute editor UI

7) QA and stabilization
   - [ ] 7.1 Headless tests for graph mutation + validation
   - [ ] 7.2 Rendering sanity checks (no missing textures, stable under zoom/pan)
   - [ ] 7.3 Interaction tests for select/drag/connect/reconnect/delete

Recommendation (updated next steps)
   - [x] A) 2.1 + 2.2 + 3.2 completed (asset schema + port sprites)
   - [x] B) 3.3 completed (edge anchors from real port layout)
   - [ ] C) Finish 4.x interaction/picking parity + selection/hover visual mapping
   - [ ] D) Implement 5.4 node-type contracts first (VALUE/CODE/GOAL editors)
   - [ ] E) Implement 5.1 + 5.2 + 5.5 (typed editing + I/O interactions via NgValueSlot)
   - [ ] F) Implement 5.3 graph-level execution UX (no individual node run action)
   - [ ] G) Persistence as final phase: 6.1 backend/model first, then 6.2 UI pipeline
   - [ ] H) QA hardening (7.x)

Notes for node-graph-assets.js cleanup
   - Candidate removals (if still unused):
     - theme.nodeFill, theme.nodeBorder, theme.nodeBorderSuccess, theme.nodeBorderError, theme.nodeBorderStale
     - node.portGapY
     - edge.dashPeriod, edge.dashFill
     - text.mode
     - nineSlice.enabled, nineSlice.size, nineSlice.borderPx
