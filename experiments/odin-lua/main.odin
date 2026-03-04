package main

import "core:fmt"
import c "core:c"

foreign import lua_lib "cbuild/liblua54_native.a"

State :: struct {}

foreign lua_lib {
	@(link_name="luaL_newstate")
	L_newstate :: proc() -> ^State ---
	@(link_name="luaL_openselectedlibs")
	L_openselectedlibs :: proc(L: ^State, load: int, preload: int) ---
	@(link_name="lua_close")
	close_state :: proc(L: ^State) ---
	@(link_name="luaL_loadstring")
	L_loadstring :: proc(L: ^State, s: cstring) -> int ---
	@(link_name="lua_pcallk")
	pcallk :: proc(L: ^State, nargs: int, nresults: int, errfunc: int, ctx: int, k: rawptr) -> int ---
	@(link_name="lua_tolstring")
	tolstring :: proc(L: ^State, idx: int, len: ^c.size_t) -> cstring ---
}

run_lua_script :: proc(state: ^State, src: cstring) {
	load_code := L_loadstring(state, src)
	if load_code != 0 {
		err := tolstring(state, -1, nil)
		fmt.println("lua load error code:", load_code)
		fmt.println("lua load error:", err)
		return
	}

	code := pcallk(state, 0, -1, 0, 0, nil)
	if code == 0 {
		result := tolstring(state, -1, nil)
		fmt.println("ok:", result)
		return
	}
	err := tolstring(state, -1, nil)
	fmt.println("lua error code:", code)
	fmt.println("lua error:", err)
}

main :: proc() {
	state := L_newstate()
	defer close_state(state)
	L_openselectedlibs(state, -1, 0)

	run_lua_script(state, "return 'hello from odin+lua'")
	run_lua_script(state, "local x =")
}
