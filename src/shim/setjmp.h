#ifndef WASM_SHIM_SETJMP_H
#define WASM_SHIM_SETJMP_H

typedef int jmp_buf[1];

int setjmp(jmp_buf env);
void longjmp(jmp_buf env, int val);

#endif
