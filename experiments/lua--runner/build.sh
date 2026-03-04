#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$ROOT_DIR/dist"
OUT_WASM="$OUT_DIR/lua_runner.wasm"

mkdir -p "$OUT_DIR"

LUA_SOURCES=(
  "$ROOT_DIR/vendor/lua/lapi.c"
  "$ROOT_DIR/vendor/lua/lauxlib.c"
  "$ROOT_DIR/vendor/lua/lbaselib.c"
  "$ROOT_DIR/vendor/lua/lcode.c"
  "$ROOT_DIR/vendor/lua/lcorolib.c"
  "$ROOT_DIR/vendor/lua/lctype.c"
  "$ROOT_DIR/vendor/lua/ldblib.c"
  "$ROOT_DIR/vendor/lua/ldebug.c"
  "$ROOT_DIR/vendor/lua/ldo.c"
  "$ROOT_DIR/vendor/lua/ldump.c"
  "$ROOT_DIR/vendor/lua/lfunc.c"
  "$ROOT_DIR/vendor/lua/lgc.c"
  "$ROOT_DIR/vendor/lua/llex.c"
  "$ROOT_DIR/vendor/lua/lmathlib.c"
  "$ROOT_DIR/vendor/lua/lmem.c"
  "$ROOT_DIR/vendor/lua/lobject.c"
  "$ROOT_DIR/vendor/lua/lopcodes.c"
  "$ROOT_DIR/vendor/lua/lparser.c"
  "$ROOT_DIR/vendor/lua/lstate.c"
  "$ROOT_DIR/vendor/lua/lstring.c"
  "$ROOT_DIR/vendor/lua/lstrlib.c"
  "$ROOT_DIR/vendor/lua/ltable.c"
  "$ROOT_DIR/vendor/lua/ltablib.c"
  "$ROOT_DIR/vendor/lua/ltm.c"
  "$ROOT_DIR/vendor/lua/lundump.c"
  "$ROOT_DIR/vendor/lua/lutf8lib.c"
  "$ROOT_DIR/vendor/lua/lvm.c"
  "$ROOT_DIR/vendor/lua/lzio.c"
)

COMMON_FLAGS=(
  -O2
  -std=c99
  -Wall
  -Wextra
  -Werror
  -s
  -fwasm-exceptions
  -mcpu=lime1+exception_handling
  -mllvm
  -wasm-enable-sjlj
  -Dl_signalT=int
  -D__WASM_SJLJ__
  -I"$ROOT_DIR/vendor/lua"
  -Wl,--no-entry
  -Wl,--export=wasm_init
  -Wl,--export=wasm_run
  -Wl,--export=wasm_http_response
  -Wl,--export=wasm_alloc
  -Wl,--export=wasm_dealloc
  -Wl,--export-memory
  -Wl,--export-table
)

echo "Building WebAssembly module with zig..."
zig cc -target wasm32-wasi "${COMMON_FLAGS[@]}" "$ROOT_DIR/lua_wasm.c" "$ROOT_DIR/wasm_setjmp_shim.c" "${LUA_SOURCES[@]}" -lm -o "$OUT_WASM"
echo "Built wasm: $OUT_WASM"
