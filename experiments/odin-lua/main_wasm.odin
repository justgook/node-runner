package main

import c "core:c"

State :: struct {}
Reader :: #type proc "c" (L: ^State, ud: rawptr, sz: ^c.size_t) -> cstring

Load_Context :: struct {
	data: cstring,
	len: c.size_t,
	done: bool,
}

@(default_calling_convention="c")
foreign {
	@(link_name="luaL_newstate")
	L_newstate :: proc() -> ^State ---
	@(link_name="lua_close")
	close_state :: proc(L: ^State) ---
	@(link_name="lua_load")
	load :: proc(L: ^State, reader: Reader, dt: rawptr, chunkname: cstring, mode: cstring) -> int ---
	@(link_name="lua_pcallk")
	pcallk :: proc(L: ^State, nargs: int, nresults: int, errfunc: int, ctx: int, k: rawptr) -> int ---
	@(link_name="lua_tolstring")
	tolstring :: proc(L: ^State, idx: int, len: ^c.size_t) -> cstring ---
}

last_message: [4096]u8
last_len: u32

store_message :: proc(msg: cstring) {
	s := string(msg)
	n := len(s)
	if n >= len(last_message) {
		n = len(last_message) - 1
	}
	for i in 0..<n {
		last_message[i] = s[i]
	}
	last_message[n] = 0
	last_len = u32(n)
}

lua_reader :: proc "c" (L: ^State, ud: rawptr, sz: ^c.size_t) -> cstring {
	_ = L
	ctx := (^Load_Context)(ud)
	if ctx.done {
		sz^ = 0
		return nil
	}
	ctx.done = true
	sz^ = ctx.len
	return ctx.data
}

run_script :: proc(src: cstring) -> u32 {
	state := L_newstate()
	if state == nil {
		store_message("failed to allocate lua state")
		return 1
	}
	defer close_state(state)

	ctx := Load_Context{data = src, len = c.size_t(len(string(src))), done = false}
	load_code := load(state, lua_reader, &ctx, "node", nil)
	if load_code != 0 {
		store_message(toluaString(state, -1))
		return 2
	}

	call_code := pcallk(state, 0, -1, 0, 0, nil)
	if call_code != 0 {
		store_message(toluaString(state, -1))
		return 3
	}

	result := toluaString(state, -1)
	if result == nil {
		store_message("<nil>")
	} else {
		store_message(result)
	}
	return 0
}

toluaString :: #force_inline proc(L: ^State, idx: int) -> cstring {
	return tolstring(L, idx, nil)
}

@(export)
run_good :: proc() -> u32 {
	return run_script("return 'hello from odin wasm lua'")
}

@(export)
run_bad :: proc() -> u32 {
	return run_script("local x =")
}

@(export)
get_last_message_ptr :: proc() -> rawptr {
	return &last_message[0]
}

@(export)
get_last_message_len :: proc() -> u32 {
	return last_len
}
