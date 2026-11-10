# Browser bridge ABI v3: complete Rust function inventory

* Source revision: `a21f651a36d789e28a4213c3ec00311be9821dc0` (the baseline before this documentation update)
* Review date: 2026-11-10
* Scope: **all Rust function declarations** in the platform `env` import block, WebGL import block, and exported functions of the wasm backend
* Contract: [ABI v3 lifecycle](abi-v3-contract.md) and [registered byte ownership](wasm-transfer-abi-v3.md)
* State: source-generated declaration inventory, verified in CI against the committed Rust sources

## Notation, units and lifecycle

Each row gives the actual Rust parameter type and result type. Every WebAssembly
pointer is an offset into the module's linear memory, not a host-process
address. An input pointer is valid only within its declared byte or element
range. Pointer ownership is **not** transferred by ordinary GL imports. Only
`allocate_transfer_vec_u8` and the registered transfer callbacks implement
JS-to-Rust ownership transfer, as documented in the separate contract.

For platform functions: Boolean values are flags; dimensions and coordinates
are pixels; `len`, `size`, `bufSize`, and `length` denote byte counts except
where the underlying GL API specifies an element count. `now` returns seconds,
and `dpi_scale` a unitless multiplier. For WebGL: `GLenum` selects a
specified GL enum; `GLuint` is an object ID or unsigned index; `GLint` and
`GLsizei` are signed integers and counts; `GLfloat` and `GLdouble` are numeric
values; buffer offsets and strides are in bytes; sizes for image upload depend
on format and pixel type. See the applicable OpenGL ES/WebGL specification for
legal enum and range combinations. The JS import must reject unsupported
WebGL2-only APIs when using a WebGL1 context.

The platform import group is callable only after loader startup / matching
ABI, and callbacks to UI or WebGL require an initialized canvas. The GPU import
group requires an active WebGL context and valid objects, and cannot be used
after `webglcontextlost`. Rust exports for the event loop are callable only
after `main` successfully installed the event handler. Browser transfers
require a registered allocation with an exact length and single consumption.
An untrusted hostile script is not a qualified caller of raw WASM exports.

The inventory includes declarations that may not be linked into the particular
`quad.wasm` fixture. The browser runtime contract test separately verifies
the **actual compiled import/export set**, and the required loader validates
each compiled import before module instantiation.

## Platform/browser imports

Source: [`src/native/wasm.rs`](../src/native/wasm.rs), `extern "C"` imports from module `env`.

| Function | Rust parameters and result | Lifecycle |
| --- | --- | --- |
| `setup_canvas_size` | `(high_dpi: bool) -> ()` | Browser platform runtime |
| `run_animation_loop` | `(blocking: bool) -> ()` | Browser platform runtime |
| `canvas_width` | `() -> i32` | Browser platform runtime |
| `canvas_height` | `() -> i32` | Browser platform runtime |
| `dpi_scale` | `() -> f32` | Browser platform runtime |
| `console_debug` | `(msg: *const ::core::ffi::c_char) -> ()` | Browser platform runtime |
| `console_log` | `(msg: *const ::core::ffi::c_char) -> ()` | Browser platform runtime |
| `console_info` | `(msg: *const ::core::ffi::c_char) -> ()` | Browser platform runtime |
| `console_warn` | `(msg: *const ::core::ffi::c_char) -> ()` | Browser platform runtime |
| `console_error` | `(msg: *const ::core::ffi::c_char) -> ()` | Browser platform runtime |
| `sapp_set_clipboard` | `(clipboard: *const i8, len: usize) -> ()` | Browser platform runtime |
| `sapp_set_cursor_grab` | `(grab: bool) -> ()` | Browser platform runtime |
| `sapp_set_cursor` | `(cursor: *const u8, len: usize) -> ()` | Browser platform runtime |
| `sapp_is_elapsed_timer_supported` | `() -> bool` | Browser platform runtime |
| `sapp_set_fullscreen` | `(fullscreen: bool) -> ()` | Browser platform runtime |
| `sapp_is_fullscreen` | `() -> bool` | Browser platform runtime |
| `sapp_set_window_size` | `(new_width: u32, new_height: u32) -> ()` | Browser platform runtime |
| `sapp_schedule_update` | `() -> ()` | Browser platform runtime |
| `init_webgl` | `(version: i32) -> ()` | Browser platform runtime |
| `now` | `() -> f64` | Browser platform runtime |
 
## WebGL imports

Source: [`src/native/wasm/webgl.rs`](../src/native/wasm/webgl.rs), `extern "C"` imports from `env`.

| Function | Rust parameters and result | Lifecycle |
| --- | --- | --- |
| `glActiveTexture` | `(texture: GLenum) -> ()` | Initialized WebGL context |
| `glAttachShader` | `(program: GLuint, shader: GLuint) -> ()` | Initialized WebGL context |
| `glBindAttribLocation` | `(program: GLuint, index: GLuint, name: *const GLchar) -> ()` | Initialized WebGL context |
| `glBindBuffer` | `(target: GLenum, buffer: GLuint) -> ()` | Initialized WebGL context |
| `glBindFramebuffer` | `(target: GLenum, framebuffer: GLuint) -> ()` | Initialized WebGL context |
| `glBindRenderbuffer` | `(target: GLenum, renderbuffer: GLuint) -> ()` | Initialized WebGL context |
| `glBindTexture` | `(target: GLenum, texture: GLuint) -> ()` | Initialized WebGL context |
| `glBlendColor` | `(red: GLfloat, green: GLfloat, blue: GLfloat, alpha: GLfloat) -> ()` | Initialized WebGL context |
| `glBlendEquation` | `(mode: GLenum) -> ()` | Initialized WebGL context |
| `glBlendEquationSeparate` | `(modeRGB: GLenum, modeAlpha: GLenum) -> ()` | Initialized WebGL context |
| `glBlendFunc` | `(sfactor: GLenum, dfactor: GLenum) -> ()` | Initialized WebGL context |
| `glBlendFuncSeparate` | `( sfactorRGB: GLenum, dfactorRGB: GLenum, sfactorAlpha: GLenum, dfactorAlpha: GLenum, ) -> ()` | Initialized WebGL context |
| `glBufferData` | `( target: GLenum, size: GLsizeiptr, data: *const ::core::ffi::c_void, usage: GLenum, ) -> ()` | Initialized WebGL context |
| `glBufferSubData` | `( target: GLenum, offset: GLintptr, size: GLsizeiptr, data: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glCheckFramebufferStatus` | `(target: GLenum) -> GLenum` | Initialized WebGL context |
| `glClear` | `(mask: GLbitfield) -> ()` | Initialized WebGL context |
| `glClearColor` | `(red: GLfloat, green: GLfloat, blue: GLfloat, alpha: GLfloat) -> ()` | Initialized WebGL context |
| `glClearDepthf` | `(d: GLfloat) -> ()` | Initialized WebGL context |
| `glClearStencil` | `(s: GLint) -> ()` | Initialized WebGL context |
| `glColorMask` | `(red: GLboolean, green: GLboolean, blue: GLboolean, alpha: GLboolean) -> ()` | Initialized WebGL context |
| `glCompileShader` | `(shader: GLuint) -> ()` | Initialized WebGL context |
| `glCompressedTexImage2D` | `( target: GLenum, level: GLint, internalformat: GLenum, width: GLsizei, height: GLsizei, border: GLint, imageSize: GLsizei, data: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glCompressedTexSubImage2D` | `( target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, width: GLsizei, height: GLsizei, format: GLenum, imageSize: GLsizei, data: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glCopyTexImage2D` | `( target: GLenum, level: GLint, internalformat: GLenum, x: GLint, y: GLint, width: GLsizei, height: GLsizei, border: GLint, ) -> ()` | Initialized WebGL context |
| `glCopyTexSubImage2D` | `( target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, x: GLint, y: GLint, width: GLsizei, height: GLsizei, ) -> ()` | Initialized WebGL context |
| `glCreateProgram` | `() -> GLuint` | Initialized WebGL context |
| `glCreateShader` | `(type_: GLenum) -> GLuint` | Initialized WebGL context |
| `glCullFace` | `(mode: GLenum) -> ()` | Initialized WebGL context |
| `glDeleteBuffers` | `(n: GLsizei, buffers: *const GLuint) -> ()` | Initialized WebGL context |
| `glDeleteFramebuffers` | `(n: GLsizei, framebuffers: *const GLuint) -> ()` | Initialized WebGL context |
| `glDeleteProgram` | `(program: GLuint) -> ()` | Initialized WebGL context |
| `glDeleteRenderbuffers` | `(n: GLsizei, renderbuffers: *const GLuint) -> ()` | Initialized WebGL context |
| `glDeleteShader` | `(shader: GLuint) -> ()` | Initialized WebGL context |
| `glDeleteTextures` | `(n: GLsizei, textures: *const GLuint) -> ()` | Initialized WebGL context |
| `glDepthFunc` | `(func: GLenum) -> ()` | Initialized WebGL context |
| `glDepthMask` | `(flag: GLboolean) -> ()` | Initialized WebGL context |
| `glDepthRangef` | `(n: GLfloat, f: GLfloat) -> ()` | Initialized WebGL context |
| `glDetachShader` | `(program: GLuint, shader: GLuint) -> ()` | Initialized WebGL context |
| `glDisable` | `(cap: GLenum) -> ()` | Initialized WebGL context |
| `glDisableVertexAttribArray` | `(index: GLuint) -> ()` | Initialized WebGL context |
| `glDrawArrays` | `(mode: GLenum, first: GLint, count: GLsizei) -> ()` | Initialized WebGL context |
| `glDrawElements` | `( mode: GLenum, count: GLsizei, type_: GLenum, indices: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glEnable` | `(cap: GLenum) -> ()` | Initialized WebGL context |
| `glEnableVertexAttribArray` | `(index: GLuint) -> ()` | Initialized WebGL context |
| `glFinish` | `() -> ()` | Initialized WebGL context |
| `glFlush` | `() -> ()` | Initialized WebGL context |
| `glFramebufferRenderbuffer` | `( target: GLenum, attachment: GLenum, renderbuffertarget: GLenum, renderbuffer: GLuint, ) -> ()` | Initialized WebGL context |
| `glFramebufferTexture2D` | `( target: GLenum, attachment: GLenum, textarget: GLenum, texture: GLuint, level: GLint, ) -> ()` | Initialized WebGL context |
| `glFrontFace` | `(mode: GLenum) -> ()` | Initialized WebGL context |
| `glGenBuffers` | `(n: GLsizei, buffers: *mut GLuint) -> ()` | Initialized WebGL context |
| `glGenerateMipmap` | `(target: GLenum) -> ()` | Initialized WebGL context |
| `glGenFramebuffers` | `(n: GLsizei, framebuffers: *mut GLuint) -> ()` | Initialized WebGL context |
| `glGenRenderbuffers` | `(n: GLsizei, renderbuffers: *mut GLuint) -> ()` | Initialized WebGL context |
| `glGenTextures` | `(n: GLsizei, textures: *mut GLuint) -> ()` | Initialized WebGL context |
| `glGetActiveAttrib` | `( program: GLuint, index: GLuint, bufSize: GLsizei, length: *mut GLsizei, size: *mut GLint, type_: *mut GLenum, name: *mut GLchar, ) -> ()` | Initialized WebGL context |
| `glGetActiveUniform` | `( program: GLuint, index: GLuint, bufSize: GLsizei, length: *mut GLsizei, size: *mut GLint, type_: *mut GLenum, name: *mut GLchar, ) -> ()` | Initialized WebGL context |
| `glGetAttachedShaders` | `( program: GLuint, maxCount: GLsizei, count: *mut GLsizei, shaders: *mut GLuint, ) -> ()` | Initialized WebGL context |
| `glGetAttribLocation` | `(program: GLuint, name: *const GLchar) -> GLint` | Initialized WebGL context |
| `glGetBooleanv` | `(pname: GLenum, data: *mut GLboolean) -> ()` | Initialized WebGL context |
| `glGetBufferParameteriv` | `(target: GLenum, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetError` | `() -> GLenum` | Initialized WebGL context |
| `glGetFloatv` | `(pname: GLenum, data: *mut GLfloat) -> ()` | Initialized WebGL context |
| `glGetFramebufferAttachmentParameteriv` | `( target: GLenum, attachment: GLenum, pname: GLenum, params: *mut GLint, ) -> ()` | Initialized WebGL context |
| `glGetIntegerv` | `(pname: GLenum, data: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetProgramiv` | `(program: GLuint, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetProgramInfoLog` | `( program: GLuint, bufSize: GLsizei, length: *mut GLsizei, infoLog: *mut GLchar, ) -> ()` | Initialized WebGL context |
| `glGetRenderbufferParameteriv` | `(target: GLenum, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetShaderiv` | `(shader: GLuint, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetShaderInfoLog` | `( shader: GLuint, bufSize: GLsizei, length: *mut GLsizei, infoLog: *mut GLchar, ) -> ()` | Initialized WebGL context |
| `glGetShaderPrecisionFormat` | `( shadertype: GLenum, precisiontype: GLenum, range: *mut GLint, precision: *mut GLint, ) -> ()` | Initialized WebGL context |
| `glGetShaderSource` | `( shader: GLuint, bufSize: GLsizei, length: *mut GLsizei, source: *mut GLchar, ) -> ()` | Initialized WebGL context |
| `glGetString` | `(name: GLenum) -> *const GLubyte` | Initialized WebGL context |
| `glGetTexParameterfv` | `(target: GLenum, pname: GLenum, params: *mut GLfloat) -> ()` | Initialized WebGL context |
| `glGetTexParameteriv` | `(target: GLenum, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetUniformfv` | `(program: GLuint, location: GLint, params: *mut GLfloat) -> ()` | Initialized WebGL context |
| `glGetUniformiv` | `(program: GLuint, location: GLint, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetUniformLocation` | `(program: GLuint, name: *const GLchar) -> GLint` | Initialized WebGL context |
| `glGetVertexAttribfv` | `(index: GLuint, pname: GLenum, params: *mut GLfloat) -> ()` | Initialized WebGL context |
| `glGetVertexAttribiv` | `(index: GLuint, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetVertexAttribPointerv` | `( index: GLuint, pname: GLenum, pointer: *mut *mut ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glHint` | `(target: GLenum, mode: GLenum) -> ()` | Initialized WebGL context |
| `glIsBuffer` | `(buffer: GLuint) -> GLboolean` | Initialized WebGL context |
| `glIsEnabled` | `(cap: GLenum) -> GLboolean` | Initialized WebGL context |
| `glIsFramebuffer` | `(framebuffer: GLuint) -> GLboolean` | Initialized WebGL context |
| `glIsProgram` | `(program: GLuint) -> GLboolean` | Initialized WebGL context |
| `glIsRenderbuffer` | `(renderbuffer: GLuint) -> GLboolean` | Initialized WebGL context |
| `glIsShader` | `(shader: GLuint) -> GLboolean` | Initialized WebGL context |
| `glIsTexture` | `(texture: GLuint) -> GLboolean` | Initialized WebGL context |
| `glLineWidth` | `(width: GLfloat) -> ()` | Initialized WebGL context |
| `glLinkProgram` | `(program: GLuint) -> ()` | Initialized WebGL context |
| `glPixelStorei` | `(pname: GLenum, param: GLint) -> ()` | Initialized WebGL context |
| `glPolygonOffset` | `(factor: GLfloat, units: GLfloat) -> ()` | Initialized WebGL context |
| `glReadPixels` | `( x: GLint, y: GLint, width: GLsizei, height: GLsizei, format: GLenum, type_: GLenum, pixels: *mut ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glReleaseShaderCompiler` | `() -> ()` | Initialized WebGL context |
| `glRenderbufferStorage` | `( target: GLenum, internalformat: GLenum, width: GLsizei, height: GLsizei, ) -> ()` | Initialized WebGL context |
| `glSampleCoverage` | `(value: GLfloat, invert: GLboolean) -> ()` | Initialized WebGL context |
| `glScissor` | `(x: GLint, y: GLint, width: GLsizei, height: GLsizei) -> ()` | Initialized WebGL context |
| `glShaderBinary` | `( count: GLsizei, shaders: *const GLuint, binaryformat: GLenum, binary: *const ::core::ffi::c_void, length: GLsizei, ) -> ()` | Initialized WebGL context |
| `glShaderSource` | `( shader: GLuint, count: GLsizei, string: *const *const GLchar, length: *const GLint, ) -> ()` | Initialized WebGL context |
| `glStencilFunc` | `(func: GLenum, ref_: GLint, mask: GLuint) -> ()` | Initialized WebGL context |
| `glStencilFuncSeparate` | `(face: GLenum, func: GLenum, ref_: GLint, mask: GLuint) -> ()` | Initialized WebGL context |
| `glStencilMask` | `(mask: GLuint) -> ()` | Initialized WebGL context |
| `glStencilMaskSeparate` | `(face: GLenum, mask: GLuint) -> ()` | Initialized WebGL context |
| `glStencilOp` | `(fail: GLenum, zfail: GLenum, zpass: GLenum) -> ()` | Initialized WebGL context |
| `glStencilOpSeparate` | `(face: GLenum, sfail: GLenum, dpfail: GLenum, dppass: GLenum) -> ()` | Initialized WebGL context |
| `glTexImage2D` | `( target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, border: GLint, format: GLenum, type_: GLenum, pixels: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glTexParameterf` | `(target: GLenum, pname: GLenum, param: GLfloat) -> ()` | Initialized WebGL context |
| `glTexParameterfv` | `(target: GLenum, pname: GLenum, params: *const GLfloat) -> ()` | Initialized WebGL context |
| `glTexParameteri` | `(target: GLenum, pname: GLenum, param: GLint) -> ()` | Initialized WebGL context |
| `glTexParameteriv` | `(target: GLenum, pname: GLenum, params: *const GLint) -> ()` | Initialized WebGL context |
| `glTexSubImage2D` | `( target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, width: GLsizei, height: GLsizei, format: GLenum, type_: GLenum, pixels: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glUniform1f` | `(location: GLint, v0: GLfloat) -> ()` | Initialized WebGL context |
| `glUniform1fv` | `(location: GLint, count: GLsizei, value: *const GLfloat) -> ()` | Initialized WebGL context |
| `glUniform1i` | `(location: GLint, v0: GLint) -> ()` | Initialized WebGL context |
| `glUniform1iv` | `(location: GLint, count: GLsizei, value: *const GLint) -> ()` | Initialized WebGL context |
| `glUniform2f` | `(location: GLint, v0: GLfloat, v1: GLfloat) -> ()` | Initialized WebGL context |
| `glUniform2fv` | `(location: GLint, count: GLsizei, value: *const GLfloat) -> ()` | Initialized WebGL context |
| `glUniform2i` | `(location: GLint, v0: GLint, v1: GLint) -> ()` | Initialized WebGL context |
| `glUniform2iv` | `(location: GLint, count: GLsizei, value: *const GLint) -> ()` | Initialized WebGL context |
| `glUniform3f` | `(location: GLint, v0: GLfloat, v1: GLfloat, v2: GLfloat) -> ()` | Initialized WebGL context |
| `glUniform3fv` | `(location: GLint, count: GLsizei, value: *const GLfloat) -> ()` | Initialized WebGL context |
| `glUniform3i` | `(location: GLint, v0: GLint, v1: GLint, v2: GLint) -> ()` | Initialized WebGL context |
| `glUniform3iv` | `(location: GLint, count: GLsizei, value: *const GLint) -> ()` | Initialized WebGL context |
| `glUniform4f` | `(location: GLint, v0: GLfloat, v1: GLfloat, v2: GLfloat, v3: GLfloat) -> ()` | Initialized WebGL context |
| `glUniform4fv` | `(location: GLint, count: GLsizei, value: *const GLfloat) -> ()` | Initialized WebGL context |
| `glUniform4i` | `(location: GLint, v0: GLint, v1: GLint, v2: GLint, v3: GLint) -> ()` | Initialized WebGL context |
| `glUniform4iv` | `(location: GLint, count: GLsizei, value: *const GLint) -> ()` | Initialized WebGL context |
| `glUniformMatrix2fv` | `( location: GLint, count: GLsizei, transpose: GLboolean, value: *const GLfloat, ) -> ()` | Initialized WebGL context |
| `glUniformMatrix3fv` | `( location: GLint, count: GLsizei, transpose: GLboolean, value: *const GLfloat, ) -> ()` | Initialized WebGL context |
| `glUniformMatrix4fv` | `( location: GLint, count: GLsizei, transpose: GLboolean, value: *const GLfloat, ) -> ()` | Initialized WebGL context |
| `glUseProgram` | `(program: GLuint) -> ()` | Initialized WebGL context |
| `glValidateProgram` | `(program: GLuint) -> ()` | Initialized WebGL context |
| `glVertexAttrib1f` | `(index: GLuint, x: GLfloat) -> ()` | Initialized WebGL context |
| `glVertexAttrib1fv` | `(index: GLuint, v: *const GLfloat) -> ()` | Initialized WebGL context |
| `glVertexAttrib2f` | `(index: GLuint, x: GLfloat, y: GLfloat) -> ()` | Initialized WebGL context |
| `glVertexAttrib2fv` | `(index: GLuint, v: *const GLfloat) -> ()` | Initialized WebGL context |
| `glVertexAttrib3f` | `(index: GLuint, x: GLfloat, y: GLfloat, z: GLfloat) -> ()` | Initialized WebGL context |
| `glVertexAttrib3fv` | `(index: GLuint, v: *const GLfloat) -> ()` | Initialized WebGL context |
| `glVertexAttrib4f` | `(index: GLuint, x: GLfloat, y: GLfloat, z: GLfloat, w: GLfloat) -> ()` | Initialized WebGL context |
| `glVertexAttrib4fv` | `(index: GLuint, v: *const GLfloat) -> ()` | Initialized WebGL context |
| `glVertexAttribPointer` | `( index: GLuint, size: GLint, type_: GLenum, normalized: GLboolean, stride: GLsizei, pointer: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glVertexAttribIPointer` | `( index: GLuint, size: GLint, type_: GLenum, stride: GLsizei, pointer: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glViewport` | `(x: GLint, y: GLint, width: GLsizei, height: GLsizei) -> ()` | Initialized WebGL context |
| `glReadBuffer` | `(src: GLenum) -> ()` | Initialized WebGL context |
| `glDrawRangeElements` | `( mode: GLenum, start: GLuint, end: GLuint, count: GLsizei, type_: GLenum, indices: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glTexImage3D` | `( target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, border: GLint, format: GLenum, type_: GLenum, pixels: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glTexSubImage3D` | `( target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, zoffset: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, format: GLenum, type_: GLenum, pixels: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glCopyTexSubImage3D` | `( target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, zoffset: GLint, x: GLint, y: GLint, width: GLsizei, height: GLsizei, ) -> ()` | Initialized WebGL context |
| `glCompressedTexImage3D` | `( target: GLenum, level: GLint, internalformat: GLenum, width: GLsizei, height: GLsizei, depth: GLsizei, border: GLint, imageSize: GLsizei, data: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glCompressedTexSubImage3D` | `( target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, zoffset: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, format: GLenum, imageSize: GLsizei, data: *const ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glGenQueries` | `(n: GLsizei, ids: *mut GLuint) -> ()` | Initialized WebGL context |
| `glDeleteQueries` | `(n: GLsizei, ids: *const GLuint) -> ()` | Initialized WebGL context |
| `glIsQuery` | `(id: GLuint) -> GLboolean` | Initialized WebGL context |
| `glBeginQuery` | `(target: GLenum, id: GLuint) -> ()` | Initialized WebGL context |
| `glEndQuery` | `(target: GLenum) -> ()` | Initialized WebGL context |
| `glGetQueryiv` | `(target: GLenum, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glQueryCounter` | `(id: GLenum, pname: GLenum) -> ()` | Initialized WebGL context |
| `glGetQueryObjectiv` | `(id: GLuint, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetQueryObjectui64v` | `(id: GLuint, pname: GLenum, params: *mut GLuint64) -> ()` | Initialized WebGL context |
| `glUnmapBuffer` | `(target: GLenum) -> GLboolean` | Initialized WebGL context |
| `glGetBufferPointerv` | `( target: GLenum, pname: GLenum, params: *mut *mut ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glDrawBuffers` | `(n: GLsizei, bufs: *const GLenum) -> ()` | Initialized WebGL context |
| `glUniformMatrix2x3fv` | `( location: GLint, count: GLsizei, transpose: GLboolean, value: *const GLfloat, ) -> ()` | Initialized WebGL context |
| `glUniformMatrix3x2fv` | `( location: GLint, count: GLsizei, transpose: GLboolean, value: *const GLfloat, ) -> ()` | Initialized WebGL context |
| `glUniformMatrix2x4fv` | `( location: GLint, count: GLsizei, transpose: GLboolean, value: *const GLfloat, ) -> ()` | Initialized WebGL context |
| `glUniformMatrix4x2fv` | `( location: GLint, count: GLsizei, transpose: GLboolean, value: *const GLfloat, ) -> ()` | Initialized WebGL context |
| `glUniformMatrix3x4fv` | `( location: GLint, count: GLsizei, transpose: GLboolean, value: *const GLfloat, ) -> ()` | Initialized WebGL context |
| `glUniformMatrix4x3fv` | `( location: GLint, count: GLsizei, transpose: GLboolean, value: *const GLfloat, ) -> ()` | Initialized WebGL context |
| `glBlitFramebuffer` | `( srcX0: GLint, srcY0: GLint, srcX1: GLint, srcY1: GLint, dstX0: GLint, dstY0: GLint, dstX1: GLint, dstY1: GLint, mask: GLbitfield, filter: GLenum, ) -> ()` | Initialized WebGL context |
| `glRenderbufferStorageMultisample` | `( target: GLenum, samples: GLsizei, internalformat: GLenum, width: GLsizei, height: GLsizei, ) -> ()` | Initialized WebGL context |
| `glFramebufferTextureLayer` | `( target: GLenum, attachment: GLenum, texture: GLuint, level: GLint, layer: GLint, ) -> ()` | Initialized WebGL context |
| `glMapBufferRange` | `( target: GLenum, offset: GLintptr, length: GLsizeiptr, access: GLbitfield, ) -> *mut ::core::ffi::c_void` | Initialized WebGL context |
| `glFlushMappedBufferRange` | `(target: GLenum, offset: GLintptr, length: GLsizeiptr) -> ()` | Initialized WebGL context |
| `glBindVertexArray` | `(array: GLuint) -> ()` | Initialized WebGL context |
| `glDeleteVertexArrays` | `(n: GLsizei, arrays: *const GLuint) -> ()` | Initialized WebGL context |
| `glGenVertexArrays` | `(n: GLsizei, arrays: *mut GLuint) -> ()` | Initialized WebGL context |
| `glIsVertexArray` | `(array: GLuint) -> GLboolean` | Initialized WebGL context |
| `glGetIntegeri_v` | `(target: GLenum, index: GLuint, data: *mut GLint) -> ()` | Initialized WebGL context |
| `glBeginTransformFeedback` | `(primitiveMode: GLenum) -> ()` | Initialized WebGL context |
| `glEndTransformFeedback` | `() -> ()` | Initialized WebGL context |
| `glBindBufferRange` | `( target: GLenum, index: GLuint, buffer: GLuint, offset: GLintptr, size: GLsizeiptr, ) -> ()` | Initialized WebGL context |
| `glBindBufferBase` | `(target: GLenum, index: GLuint, buffer: GLuint) -> ()` | Initialized WebGL context |
| `glTransformFeedbackVaryings` | `( program: GLuint, count: GLsizei, varyings: *const *const GLchar, bufferMode: GLenum, ) -> ()` | Initialized WebGL context |
| `glGetTransformFeedbackVarying` | `( program: GLuint, index: GLuint, bufSize: GLsizei, length: *mut GLsizei, size: *mut GLsizei, type_: *mut GLenum, name: *mut GLchar, ) -> ()` | Initialized WebGL context |
| `glGetVertexAttribIiv` | `(index: GLuint, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetVertexAttribIuiv` | `(index: GLuint, pname: GLenum, params: *mut GLuint) -> ()` | Initialized WebGL context |
| `glVertexAttribI4i` | `(index: GLuint, x: GLint, y: GLint, z: GLint, w: GLint) -> ()` | Initialized WebGL context |
| `glVertexAttribI4ui` | `(index: GLuint, x: GLuint, y: GLuint, z: GLuint, w: GLuint) -> ()` | Initialized WebGL context |
| `glVertexAttribI4iv` | `(index: GLuint, v: *const GLint) -> ()` | Initialized WebGL context |
| `glVertexAttribI4uiv` | `(index: GLuint, v: *const GLuint) -> ()` | Initialized WebGL context |
| `glGetUniformuiv` | `(program: GLuint, location: GLint, params: *mut GLuint) -> ()` | Initialized WebGL context |
| `glGetFragDataLocation` | `(program: GLuint, name: *const GLchar) -> GLint` | Initialized WebGL context |
| `glUniform1ui` | `(location: GLint, v0: GLuint) -> ()` | Initialized WebGL context |
| `glUniform2ui` | `(location: GLint, v0: GLuint, v1: GLuint) -> ()` | Initialized WebGL context |
| `glUniform3ui` | `(location: GLint, v0: GLuint, v1: GLuint, v2: GLuint) -> ()` | Initialized WebGL context |
| `glUniform4ui` | `(location: GLint, v0: GLuint, v1: GLuint, v2: GLuint, v3: GLuint) -> ()` | Initialized WebGL context |
| `glUniform1uiv` | `(location: GLint, count: GLsizei, value: *const GLuint) -> ()` | Initialized WebGL context |
| `glUniform2uiv` | `(location: GLint, count: GLsizei, value: *const GLuint) -> ()` | Initialized WebGL context |
| `glUniform3uiv` | `(location: GLint, count: GLsizei, value: *const GLuint) -> ()` | Initialized WebGL context |
| `glUniform4uiv` | `(location: GLint, count: GLsizei, value: *const GLuint) -> ()` | Initialized WebGL context |
| `glClearBufferiv` | `(buffer: GLenum, drawbuffer: GLint, value: *const GLint) -> ()` | Initialized WebGL context |
| `glClearBufferuiv` | `(buffer: GLenum, drawbuffer: GLint, value: *const GLuint) -> ()` | Initialized WebGL context |
| `glClearBufferfv` | `(buffer: GLenum, drawbuffer: GLint, value: *const GLfloat) -> ()` | Initialized WebGL context |
| `glClearBufferfi` | `(buffer: GLenum, drawbuffer: GLint, depth: GLfloat, stencil: GLint) -> ()` | Initialized WebGL context |
| `glGetStringi` | `(name: GLenum, index: GLuint) -> *const GLubyte` | Initialized WebGL context |
| `glCopyBufferSubData` | `( readTarget: GLenum, writeTarget: GLenum, readOffset: GLintptr, writeOffset: GLintptr, size: GLsizeiptr, ) -> ()` | Initialized WebGL context |
| `glGetUniformIndices` | `( program: GLuint, uniformCount: GLsizei, uniformNames: *const *const GLchar, uniformIndices: *mut GLuint, ) -> ()` | Initialized WebGL context |
| `glGetActiveUniformsiv` | `( program: GLuint, uniformCount: GLsizei, uniformIndices: *const GLuint, pname: GLenum, params: *mut GLint, ) -> ()` | Initialized WebGL context |
| `glGetUniformBlockIndex` | `(program: GLuint, uniformBlockName: *const GLchar) -> GLuint` | Initialized WebGL context |
| `glGetActiveUniformBlockiv` | `( program: GLuint, uniformBlockIndex: GLuint, pname: GLenum, params: *mut GLint, ) -> ()` | Initialized WebGL context |
| `glGetActiveUniformBlockName` | `( program: GLuint, uniformBlockIndex: GLuint, bufSize: GLsizei, length: *mut GLsizei, uniformBlockName: *mut GLchar, ) -> ()` | Initialized WebGL context |
| `glUniformBlockBinding` | `( program: GLuint, uniformBlockIndex: GLuint, uniformBlockBinding: GLuint, ) -> ()` | Initialized WebGL context |
| `glDrawArraysInstanced` | `( mode: GLenum, first: GLint, count: GLsizei, instancecount: GLsizei, ) -> ()` | Initialized WebGL context |
| `glDrawElementsInstanced` | `( mode: GLenum, count: GLsizei, type_: GLenum, indices: *const ::core::ffi::c_void, instancecount: GLsizei, ) -> ()` | Initialized WebGL context |
| `glFenceSync` | `(condition: GLenum, flags: GLbitfield) -> GLsync` | Initialized WebGL context |
| `glIsSync` | `(sync: GLsync) -> GLboolean` | Initialized WebGL context |
| `glDeleteSync` | `(sync: GLsync) -> ()` | Initialized WebGL context |
| `glClientWaitSync` | `(sync: GLsync, flags: GLbitfield, timeout: GLuint64) -> GLenum` | Initialized WebGL context |
| `glWaitSync` | `(sync: GLsync, flags: GLbitfield, timeout: GLuint64) -> ()` | Initialized WebGL context |
| `glGetInteger64v` | `(pname: GLenum, data: *mut GLint64) -> ()` | Initialized WebGL context |
| `glGetSynciv` | `( sync: GLsync, pname: GLenum, bufSize: GLsizei, length: *mut GLsizei, values: *mut GLint, ) -> ()` | Initialized WebGL context |
| `glGetInteger64i_v` | `(target: GLenum, index: GLuint, data: *mut GLint64) -> ()` | Initialized WebGL context |
| `glGetBufferParameteri64v` | `(target: GLenum, pname: GLenum, params: *mut GLint64) -> ()` | Initialized WebGL context |
| `glGenSamplers` | `(count: GLsizei, samplers: *mut GLuint) -> ()` | Initialized WebGL context |
| `glDeleteSamplers` | `(count: GLsizei, samplers: *const GLuint) -> ()` | Initialized WebGL context |
| `glIsSampler` | `(sampler: GLuint) -> GLboolean` | Initialized WebGL context |
| `glBindSampler` | `(unit: GLuint, sampler: GLuint) -> ()` | Initialized WebGL context |
| `glSamplerParameteri` | `(sampler: GLuint, pname: GLenum, param: GLint) -> ()` | Initialized WebGL context |
| `glSamplerParameteriv` | `(sampler: GLuint, pname: GLenum, param: *const GLint) -> ()` | Initialized WebGL context |
| `glSamplerParameterf` | `(sampler: GLuint, pname: GLenum, param: GLfloat) -> ()` | Initialized WebGL context |
| `glSamplerParameterfv` | `(sampler: GLuint, pname: GLenum, param: *const GLfloat) -> ()` | Initialized WebGL context |
| `glGetSamplerParameteriv` | `(sampler: GLuint, pname: GLenum, params: *mut GLint) -> ()` | Initialized WebGL context |
| `glGetSamplerParameterfv` | `(sampler: GLuint, pname: GLenum, params: *mut GLfloat) -> ()` | Initialized WebGL context |
| `glVertexAttribDivisor` | `(index: GLuint, divisor: GLuint) -> ()` | Initialized WebGL context |
| `glBindTransformFeedback` | `(target: GLenum, id: GLuint) -> ()` | Initialized WebGL context |
| `glDeleteTransformFeedbacks` | `(n: GLsizei, ids: *const GLuint) -> ()` | Initialized WebGL context |
| `glGenTransformFeedbacks` | `(n: GLsizei, ids: *mut GLuint) -> ()` | Initialized WebGL context |
| `glIsTransformFeedback` | `(id: GLuint) -> GLboolean` | Initialized WebGL context |
| `glPauseTransformFeedback` | `() -> ()` | Initialized WebGL context |
| `glResumeTransformFeedback` | `() -> ()` | Initialized WebGL context |
| `glGetProgramBinary` | `( program: GLuint, bufSize: GLsizei, length: *mut GLsizei, binaryFormat: *mut GLenum, binary: *mut ::core::ffi::c_void, ) -> ()` | Initialized WebGL context |
| `glProgramBinary` | `( program: GLuint, binaryFormat: GLenum, binary: *const ::core::ffi::c_void, length: GLsizei, ) -> ()` | Initialized WebGL context |
| `glProgramParameteri` | `(program: GLuint, pname: GLenum, value: GLint) -> ()` | Initialized WebGL context |
| `glInvalidateFramebuffer` | `( target: GLenum, numAttachments: GLsizei, attachments: *const GLenum, ) -> ()` | Initialized WebGL context |
| `glInvalidateSubFramebuffer` | `( target: GLenum, numAttachments: GLsizei, attachments: *const GLenum, x: GLint, y: GLint, width: GLsizei, height: GLsizei, ) -> ()` | Initialized WebGL context |
| `glTexStorage2D` | `( target: GLenum, levels: GLsizei, internalformat: GLenum, width: GLsizei, height: GLsizei, ) -> ()` | Initialized WebGL context |
| `glTexStorage3D` | `( target: GLenum, levels: GLsizei, internalformat: GLenum, width: GLsizei, height: GLsizei, depth: GLsizei, ) -> ()` | Initialized WebGL context |
| `glGetInternalformativ` | `( target: GLenum, internalformat: GLenum, pname: GLenum, bufSize: GLsizei, params: *mut GLint, ) -> ()` | Initialized WebGL context |

## Rust exports

Source: [`src/native/wasm.rs`](../src/native/wasm.rs), exported functions called by `js/gl.js`.

| Function | Rust parameters and result | Lifecycle |
| --- | --- | --- |
| `crate_version` | `() -> u32` | Matching ABI v3; see export lifecycle contract |
| `allocate_vec_u8` | `(len: usize) -> *mut u8` | Matching ABI v3; see export lifecycle contract |
| `allocate_transfer_vec_u8` | `(len: usize) -> *mut u8` | Matching ABI v3; see export lifecycle contract |
| `discard_transfer_vec_u8` | `(ptr: *mut u8) -> ()` | Matching ABI v3; see export lifecycle contract |
| `on_clipboard_paste` | `(msg: *mut u8, len: usize) -> ()` | Matching ABI v3; see export lifecycle contract |
| `frame` | `() -> ()` | Matching ABI v3; see export lifecycle contract |
| `mouse_move` | `(x: i32, y: i32) -> ()` | Matching ABI v3; see export lifecycle contract |
| `raw_mouse_move` | `(dx: i32, dy: i32) -> ()` | Matching ABI v3; see export lifecycle contract |
| `mouse_down` | `(x: i32, y: i32, btn: i32) -> ()` | Matching ABI v3; see export lifecycle contract |
| `mouse_up` | `(x: i32, y: i32, btn: i32) -> ()` | Matching ABI v3; see export lifecycle contract |
| `mouse_wheel` | `(dx: i32, dy: i32) -> ()` | Matching ABI v3; see export lifecycle contract |
| `key_down` | `(key: u32, modifiers: u32, repeat: bool) -> ()` | Matching ABI v3; see export lifecycle contract |
| `key_press` | `(key: u32) -> ()` | Matching ABI v3; see export lifecycle contract |
| `key_up` | `(key: u32, modifiers: u32) -> ()` | Matching ABI v3; see export lifecycle contract |
| `resize` | `(width: i32, height: i32) -> ()` | Matching ABI v3; see export lifecycle contract |
| `touch` | `(phase: u32, id: u32, x: f32, y: f32) -> ()` | Matching ABI v3; see export lifecycle contract |
| `focus` | `(has_focus: bool) -> ()` | Matching ABI v3; see export lifecycle contract |
| `on_files_dropped_start` | `() -> ()` | Matching ABI v3; see export lifecycle contract |
| `on_files_dropped_finish` | `() -> ()` | Matching ABI v3; see export lifecycle contract |
| `on_file_dropped` | `( path: *mut u8, path_len: usize, bytes: *mut u8, bytes_len: usize, ) -> ()` | Matching ABI v3; see export lifecycle contract |

## Validation method and limits

Run `node scripts/check-abi-inventory.mjs` to ensure there are no missing,
unknown or duplicate declarations in any inventory group. The integration
workflow also executes the actual browser
`tests/browser/abi-contract.spec.mjs` on a compiled WASM module and exercises
runtime browser behavior in Chromium. The separate three-engine workflow runs
the browser tests in Chromium, Firefox and WebKit.

This is declaration-level verification, not automatic validation of every
WebGL argument-value combination. A source signature added or removed must
update this file and pass CI. No physical iOS/Android testing or complete
cross-platform native assurance is inferred.
