//! Minimal C-ABI surface for the browser (no wasm-bindgen needed).
//! See web/foar-wasm.js for the JS side.
use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn f4_alloc(len: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align_unchecked(len.max(1), 1)) }
}

#[no_mangle]
pub extern "C" fn f4_free(ptr: *mut u8, len: usize) {
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), 1)) }
}

fn into_buffer(json: String) -> *mut u8 {
    let json = json.into_bytes();
    let n = json.len();
    let out = f4_alloc(n + 4);
    unsafe {
        std::ptr::copy_nonoverlapping((n as u32).to_le_bytes().as_ptr(), out, 4);
        std::ptr::copy_nonoverlapping(json.as_ptr(), out.add(4), n);
    }
    out
}

/// Compiles UTF-8 source at (ptr,len). Returns a buffer `[u32 len LE][json]`
/// that the caller releases with `f4_free(ptr, len + 4)`.
#[no_mangle]
pub extern "C" fn f4_compile(ptr: *const u8, len: usize) -> *mut u8 {
    let src = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)) };
    into_buffer(crate::compile_to_json(src, false))
}

/// Compiles a multi-file project given as JSON `{"entry", "files": {path: source}}`
/// (see crate::project). Same buffer protocol as `f4_compile`.
#[no_mangle]
pub extern "C" fn f4_compile_project(ptr: *const u8, len: usize) -> *mut u8 {
    let input = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)) };
    into_buffer(crate::project::compile_project_json(input))
}
