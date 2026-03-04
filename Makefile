SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c

BUILD_DIR ?= build.nosync
WASM_NAME ?= node-runner.wasm
LUA_DIR := src/vendor/lua

LUA_CORE := \
	lapi.c lcode.c lctype.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c \
	lmem.c lobject.c lopcodes.c lparser.c lstate.c lstring.c ltable.c ltm.c \
	lundump.c lvm.c lzio.c

LUA_LIB := \
	lauxlib.c lbaselib.c lmathlib.c lstrlib.c ltablib.c lutf8lib.c

LUA_SRCS := $(addprefix $(LUA_DIR)/,$(LUA_CORE) $(LUA_LIB))
SRC := src/main.c src/shim/wasm_setjmp_shim.c $(LUA_SRCS)

EXPORTS := \
	-Wl,--export=ng_init \
	-Wl,--export=ng_get_info_ptr \
	-Wl,--export=ng_clear_graph \
	-Wl,--export=ng_node_create \
	-Wl,--export=ng_node_replace \
	-Wl,--export=ng_node_delete \
	-Wl,--export=ng_input_add \
	-Wl,--export=ng_input_remove \
	-Wl,--export=ng_output_add \
	-Wl,--export=ng_output_remove \
	-Wl,--export=ng_input_connect \
	-Wl,--export=ng_input_disconnect \
	-Wl,--export=ng_node_set_arg \
	-Wl,--export=ng_run_all_goals \
	-Wl,--export=ng_run_goal \
	-Wl,--export=ng_run_start \
	-Wl,--export=ng_run_response \
	-Wl,--export=ng_run_cancel \
	-Wl,--export=ng_exec_clear \
	-Wl,--export=ng_exec_clear_all \
	-Wl,--export=ng_get_last_error \
	-Wl,--export=ng_get_io_ptr \
	-Wl,--export=ng_get_io_len \
	-Wl,--export=ng_get_node_exec_state

.PHONY: all web clean

all: web

$(WASM_NAME): $(SRC)
	zig cc $(SRC) \
		-target wasm32-wasi \
		-O2 \
		-std=c99 \
		-fwasm-exceptions \
		-mcpu=lime1+exception_handling \
		-mllvm -wasm-enable-sjlj \
		-Dl_signalT=int \
		-D__WASM_SJLJ__ \
		-I$(LUA_DIR) \
		-Wl,--no-entry \
		-Wl,--export-memory \
		-Wl,--export-table \
		$(EXPORTS) \
		-o $@

web: $(WASM_NAME)
	mkdir -p $(BUILD_DIR)/web
	mkdir -p $(BUILD_DIR)/web/assets
	mv $(WASM_NAME) $(BUILD_DIR)/web/
	cp -f index.html $(BUILD_DIR)/web/
	cp -f node-graph-assets.js $(BUILD_DIR)/web/
	cp -f node-graph-view.js $(BUILD_DIR)/web/
	cp -f assets/atlas-mtsdf.json $(BUILD_DIR)/web/assets/
	cp -f assets/atlas-mtsdf.png $(BUILD_DIR)/web/assets/
	cp -f assets/nine.png $(BUILD_DIR)/web/assets/
	cp -f assets/port-full.png $(BUILD_DIR)/web/assets/
	cp -f assets/port-empty.png $(BUILD_DIR)/web/assets/
	cp -f assets/example.json $(BUILD_DIR)/web/assets/

clean:
	rm -rf $(BUILD_DIR) $(WASM_NAME)
