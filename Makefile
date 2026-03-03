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
SRC := src/main.c src/shim/setjmp.c $(LUA_SRCS)

.PHONY: all web clean

all: web

$(WASM_NAME): $(SRC)
	zig build-exe $(SRC) \
		-target wasm32-wasi \
		-lc \
		-fno-entry \
		-Dl_signalT=int \
		-Isrc/shim \
		-I$(LUA_DIR) \
		--import-symbols \
		-rdynamic \
		-O ReleaseSmall \
		-fstrip \
		-femit-bin=$@

web: $(WASM_NAME)
	mkdir -p $(BUILD_DIR)/web
	mkdir -p $(BUILD_DIR)/web/assets
	mv $(WASM_NAME) $(BUILD_DIR)/web/
	cp -f index.html $(BUILD_DIR)/web/
	cp -f wasi.js $(BUILD_DIR)/web/
	cp -f node-graph-assets.js $(BUILD_DIR)/web/
	cp -f node-graph-view.js $(BUILD_DIR)/web/
	cp -f assets/atlas-mtsdf.json $(BUILD_DIR)/web/assets/
	cp -f assets/atlas-mtsdf.png $(BUILD_DIR)/web/assets/
	cp -f assets/nine.png $(BUILD_DIR)/web/assets/

clean:
	rm -rf $(BUILD_DIR) $(WASM_NAME)
