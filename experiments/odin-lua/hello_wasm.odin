package main

hello_msg: string = "hello from odin wasm"

@(export)
hello_ptr :: proc() -> rawptr {
	return raw_data(hello_msg)
}

@(export)
hello_len :: proc() -> u32 {
	return u32(len(hello_msg))
}
