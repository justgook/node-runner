const fs = require("fs");
const path = require("path");
const { WASI } = require("node:wasi");

const ERR = {
  OK: 0,
  BAD_ARG: 1,
  COMPILE: 2,
  RUNTIME: 3,
  INIT: 4,
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

  const wasi = new WASI({
    version: "preview1",
    args: ["node-runner.wasm"],
    env: {},
    preopens: {},
  });

  const wasmBytes = fs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  wasi.start(instance);

  const api = instance.exports;
  const memory = api.memory;

  console.log("[test] exports:", Object.keys(api).sort().join(", "));

  if (typeof api.init_runner !== "function") throw new Error("missing export: init_runner");
  if (typeof api.run_input !== "function") throw new Error("missing export: run_input");

  const td = new TextDecoder();

  function writeInput(source) {
    const bytes = Buffer.from(source, "utf8");
    const cap = api.get_input_cap();
    if (bytes.length > cap) {
      throw new Error(`input too large (${bytes.length} > ${cap})`);
    }
    const ptr = api.get_input_ptr();
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    return bytes.length;
  }

  function outputText() {
    const ptr = api.get_output_ptr();
    const len = api.get_output_len();
    return td.decode(new Uint8Array(memory.buffer, ptr, len));
  }

  function errorText() {
    const ptr = api.get_error_ptr();
    const len = api.get_error_len();
    return td.decode(new Uint8Array(memory.buffer, ptr, len));
  }

  assertEq(api.init_runner(), ERR.OK, "init_runner must succeed");

  let len = writeInput('print("hello from lua")');
  assertEq(api.run_input(len), ERR.OK, "hello script should run");
  assertIncludes(outputText(), "hello from lua", "hello output should contain text");

  len = writeInput("local x=2+5; print(x)");
  assertEq(api.run_input(len), ERR.OK, "arithmetic script should run");
  assertIncludes(outputText(), "7", "arithmetic output should contain 7");

  console.log("[test] all checks passed");
}

run().catch((err) => {
  console.error("[test] failed:", err.message);
  process.exit(1);
});
