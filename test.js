const fs = require("fs");
const path = require("path");

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
  const sourceMap = new Map([[1, 'local resp = host.awaitCall("mock", "get", "seed")\nprint(resp)']]);

  const wasiPreview1 = {
    clock_time_get: (_clockId, _precision, outPtr) => {
      if (!memory) return 0;
      new DataView(memory.buffer).setBigUint64(outPtr, BigInt(Date.now() * 1000000), true);
      return 0;
    },
    fd_close: () => 0,
    fd_fdstat_get: () => 58,
    fd_fdstat_set_flags: () => 58,
    fd_prestat_get: () => 58,
    fd_prestat_dir_name: () => 58,
    fd_read: () => 52,
    fd_renumber: () => 58,
    fd_seek: (_fd, _offsetLow, _offsetHigh, _whence, newOffsetPtr) => {
      if (memory) new DataView(memory.buffer).setBigUint64(newOffsetPtr, 0n, true);
      return 52;
    },
    fd_write: (_fd, _iovs, _iovsLen, nwrittenPtr) => {
      if (memory) new DataView(memory.buffer).setUint32(nwrittenPtr, 0, true);
      return 0;
    },
    path_open: () => 52,
    proc_exit: (code) => {
      throw new Error(`wasi proc_exit(${code})`);
    },
  };

  const wasmBytes = fs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: wasiPreview1,
    env: {
      ng_on_node_changed: () => { },
      ng_on_run_event: () => { },
      ng_host_resolve: (nodeId, resolveKind, reqPtr, reqLen, outPtr, outCap, outLenPtr) => {
        if (!memory) return 7;
        let payload = "";
        if (resolveKind === 1) {
          payload = sourceMap.get(nodeId) || "";
        } else if (resolveKind === 2) {
          payload = "mock-await-response";
        } else if (resolveKind === 3) {
          payload = `value-node-${nodeId}`;
        } else {
          return 7;
        }
        const bytes = Buffer.from(payload, "utf8");
        if (bytes.length > outCap) return 4;
        new Uint8Array(memory.buffer, outPtr, bytes.length).set(bytes);
        new DataView(memory.buffer).setInt32(outLenPtr, bytes.length, true);
        return 0;
      },
      ng_host_request: () => 0,
    },
  });

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

  assertEq(api.ng_node_create(2, NG.NODE_GOAL), ERR.OK, "create node-goal 2");
  assertEq(api.ng_input_add(2, 1), ERR.OK, "add goal input");
  assertEq(api.ng_input_connect(2, 1, 1, 1), ERR.OK, "connect goal 2 <- code");

  assertEq(api.ng_node_create(3, NG.NODE_GOAL), ERR.OK, "create node-goal 3");
  assertEq(api.ng_input_add(3, 1), ERR.OK, "add goal 3 input");
  assertEq(api.ng_input_connect(3, 1, 1, 1), ERR.OK, "connect goal 3 <- code");

  assertEq(api.ng_run_start(0), ERR.OK, "run should finish through awaitCall mock");

  assertIncludes(readOutputFromInfo(), "mock-await-response", "output should contain awaited mock response");

  assertEq(api.ng_get_node_exec_state(1), NG.EXEC_SUCCESS, "node-code should be success");
  assertEq(api.ng_get_node_exec_state(2), NG.EXEC_SUCCESS, "node-goal 2 should be success");
  assertEq(api.ng_get_node_exec_state(3), NG.EXEC_SUCCESS, "node-goal 3 should be success");

  assertEq(api.ng_exec_clear_all(), ERR.OK, "clear exec state before delete");
  assertEq(api.ng_node_delete(2), ERR.OK, "delete one goal");
  assertEq(api.ng_run_all_goals(), ERR.OK, "run all goals should ignore deleted goals");

  console.log("[test] all checks passed");
}

run().catch((err) => {
  console.error("[test] failed:", err.message);
  process.exit(1);
});
