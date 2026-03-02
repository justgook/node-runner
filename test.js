const fs = require("fs");
const path = require("path");
const { WASI } = require("node:wasi");

const ERR = {
  OK: 0,
};

const NG = {
  NODE_GOAL: 1,
  NODE_CODE: 2,
  EXEC_SUCCESS: 1,
};

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${expected}, got=${actual}`);
  }
}

function assertIncludes(actual, expected, message) {
  if (!actual.includes(expected)) {
    throw new Error(`${message}. expected substring=${JSON.stringify(expected)}, got=${JSON.stringify(actual)}`);
  }
}

async function run() {
  const wasmPath = path.join(__dirname, "build.nosync/web/node-runner.wasm");
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Missing ${wasmPath}. Run: make web`);
  }

  let memory = null;
  const sourceMap = new Map([[1, 'print("hello from node-code")']]);

  const wasi = new WASI({
    version: "preview1",
    args: ["node-runner.wasm"],
    env: {},
    preopens: {},
  });

  const wasmBytes = fs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: wasi.wasiImport,
    env: {
      ng_on_node_changed: () => {},
      ng_on_run_event: () => {},
      ng_host_resolve: (nodeId, resolveKind, reqPtr, reqLen, outPtr, outCap, outLenPtr) => {
        if (!memory) return 7;
        if (resolveKind !== 1) return 7;
        const src = sourceMap.get(nodeId) || "";
        const bytes = Buffer.from(src, "utf8");
        if (bytes.length > outCap) return 4;
        new Uint8Array(memory.buffer, outPtr, bytes.length).set(bytes);
        new DataView(memory.buffer).setInt32(outLenPtr, bytes.length, true);
        return 0;
      },
    },
  });
  wasi.start(instance);

  const api = instance.exports;
  memory = api.memory;

  console.log("[test] exports:", Object.keys(api).sort().join(", "));

  if (typeof api.ng_init !== "function") throw new Error("missing export: ng_init");
  if (typeof api.ng_run_goal !== "function") throw new Error("missing export: ng_run_goal");

  const td = new TextDecoder();
  function readOutputFromInfo() {
    const ptr = api.ng_get_io_ptr();
    const len = api.ng_get_io_len();
    return td.decode(new Uint8Array(memory.buffer, ptr, len));
  }

  assertEq(api.ng_init(), ERR.OK, "ng_init must succeed");
  assertEq(api.ng_clear_graph(), ERR.OK, "ng_clear_graph must succeed");

  assertEq(api.ng_node_create(1, NG.NODE_CODE), ERR.OK, "create node-code");
  assertEq(api.ng_output_add(1, 1), ERR.OK, "add code output");

  assertEq(api.ng_node_create(2, NG.NODE_GOAL), ERR.OK, "create node-goal");
  assertEq(api.ng_input_add(2, 1), ERR.OK, "add goal input");
  assertEq(api.ng_input_connect(2, 1, 1, 1), ERR.OK, "connect goal <- code");
  assertEq(api.ng_goal_set(2, 1), ERR.OK, "enable goal");

  assertEq(api.ng_run_goal(2), ERR.OK, "goal pipeline should run");
  assertIncludes(readOutputFromInfo(), "hello from node-code", "output should contain Lua print");

  assertEq(api.ng_get_node_exec_state(1), NG.EXEC_SUCCESS, "node-code should be success");
  assertEq(api.ng_get_node_exec_state(2), NG.EXEC_SUCCESS, "node-goal should be success");

  console.log("[test] all checks passed");
}

run().catch((err) => {
  console.error("[test] failed:", err.message);
  process.exit(1);
});
