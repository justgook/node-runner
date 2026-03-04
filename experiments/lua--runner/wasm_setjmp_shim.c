#include <assert.h>
#include <stddef.h>
#include <stdint.h>

struct wasm_longjmp_args {
  void *env;
  int val;
};

struct jmp_buf_impl {
  void *func_invocation_id;
  uint32_t label;
  struct wasm_longjmp_args arg;
};

void __wasm_setjmp(void *env, uint32_t label, void *func_invocation_id) {
  struct jmp_buf_impl *jb = (struct jmp_buf_impl *)env;
  assert(label != 0);
  assert(func_invocation_id != NULL);
  jb->func_invocation_id = func_invocation_id;
  jb->label = label;
}

uint32_t __wasm_setjmp_test(void *env, void *func_invocation_id) {
  struct jmp_buf_impl *jb = (struct jmp_buf_impl *)env;
  assert(jb->label != 0);
  assert(func_invocation_id != NULL);
  if (jb->func_invocation_id == func_invocation_id) {
    return jb->label;
  }
  return 0;
}

void __wasm_longjmp(void *env, int val) {
  struct jmp_buf_impl *jb = (struct jmp_buf_impl *)env;
  struct wasm_longjmp_args *arg = &jb->arg;

  if (val == 0) {
    val = 1;
  }

  arg->env = env;
  arg->val = val;

  __builtin_wasm_throw(1, arg);
}
