/* wasm-enc.js — 极简 WebAssembly 二进制编码器（无第三方依赖）
 * 浏览器 Worker 中挂载为全局 WasmEnc；Node 中通过 require 使用。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WasmEnc = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, funcref: 0x70, externref: 0x6f };
  const KIND = { func: 0x00, table: 0x01, mem: 0x02, global: 0x03 };

  // 无符号 LEB128
  function u(n) {
    const b = [];
    n = n >>> 0;
    do {
      let x = n & 0x7f;
      n = Math.floor(n / 128);
      if (n > 0) x |= 0x80;
      b.push(x);
    } while (n > 0);
    return b;
  }

  // 有符号 LEB128（32 位范围足够本演示使用）
  function s(n) {
    const b = [];
    let more = true;
    while (more) {
      let x = n & 0x7f;
      n >>= 7;
      if ((n === 0 && (x & 0x40) === 0) || (n === -1 && (x & 0x40) !== 0)) more = false;
      else x |= 0x80;
      b.push(x & 0xff);
    }
    return b;
  }

  function str(x) {
    const bytes = [];
    for (let i = 0; i < x.length; i++) bytes.push(x.charCodeAt(i) & 0x7f);
    return [...u(bytes.length), ...bytes];
  }

  function vec(items) {
    return [...u(items.length), ...items.flat()];
  }

  function section(id, payload) {
    return [id, ...u(payload.length), ...payload];
  }

  // ---- 指令 helpers ----
  const OP = {
    unreachable: [0x00],
    drop: [0x1a],
    ret: [0x0f],
    i32add: [0x6a],
    i32sub: [0x6b],
    i32mul: [0x6c],
    refIsNull: [0xd1],
    i32c: (v) => [0x41, ...s(v)],
    lg: (i) => [0x20, ...u(i)],          // local.get
    ls: (i) => [0x21, ...u(i)],          // local.set
    call: (f) => [0x10, ...u(f)],
    callInd: (ty, tb) => [0x11, ...u(ty), ...u(tb)],
    // i32.load8_u：mem>0 时 memarg 的 align 标志位置 bit6，随后跟 memidx
    load8u: (mem, off = 0) => (mem ? [0x2d, 0x40, ...u(mem), ...u(off)] : [0x2d, 0x00, ...u(off)]),
    memSize: (mem) => [0x3f, ...u(mem)],
    memGrow: (mem) => [0x40, ...u(mem)],
    memFill: (mem) => [0xfc, 0x0b, ...u(mem)],
    memCopy: (dst, src) => [0xfc, 0x0a, ...u(dst), ...u(src)],
    tblGet: (t) => [0x25, ...u(t)],
    tblSet: (t) => [0x26, ...u(t)],
    tblGrow: (t) => [0xfc, 0x0f, ...u(t)],
    tblSize: (t) => [0xfc, 0x10, ...u(t)],
    tblCopy: (dst, src) => [0xfc, 0x0e, ...u(dst), ...u(src)],
    refNull: (ht) => [0xd0, ht],
    refFunc: (f) => [0xd2, ...u(f)],
  };

  class MB {
    constructor() {
      this.types = [];
      this.imports = [];
      this.importedFuncCount = 0;
      this.funcs = [];
      this.codes = [];
      this.tables = [];
      this.mems = [];
      this.exports = [];
      this.elems = [];
      this.datas = [];
      this.start = null;
    }
    type(params, results) {
      this.types.push([0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))]);
      return this.types.length - 1;
    }
    importFunc(mod, name, typeIdx) {
      this.imports.push([...str(mod), ...str(name), KIND.func, ...u(typeIdx)]);
      return this.importedFuncCount++;
    }
    func(typeIdx, locals, body) {
      const idx = this.importedFuncCount + this.funcs.length;
      this.funcs.push([...u(typeIdx)]);
      const localDecls = vec((locals || []).map(([c, t]) => [...u(c), t]));
      const code = [...localDecls, ...body, 0x0b];
      this.codes.push([...u(code.length), ...code]);
      return idx;
    }
    table(reftype, min, max) {
      this.tables.push(max == null ? [reftype, 0x00, ...u(min)] : [reftype, 0x01, ...u(min), ...u(max)]);
      return this.tables.length - 1;
    }
    memory(min, max) {
      this.mems.push(max == null ? [0x00, ...u(min)] : [0x01, ...u(min), ...u(max)]);
      return this.mems.length - 1;
    }
    export(name, kind, idx) {
      this.exports.push([...str(name), kind, ...u(idx)]);
    }
    elemActive(tableIdx, offsetExpr, funcIdxs) {
      this.elems.push([0x02, ...u(tableIdx), ...offsetExpr, 0x0b, 0x00, ...vec(funcIdxs.map((f) => u(f)))]);
    }
    dataActive(memIdx, offset, bytes) {
      const off = [...OP.i32c(offset), 0x0b];
      if (memIdx === 0) this.datas.push([0x00, ...off, ...vec(bytes.map((b) => [b]))]);
      else this.datas.push([0x02, ...u(memIdx), ...off, ...vec(bytes.map((b) => [b]))]);
    }
    setStart(funcIdx) {
      this.start = funcIdx;
    }
    bytes() {
      const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
      if (this.types.length) out.push(...section(1, vec(this.types)));
      if (this.imports.length) out.push(...section(2, vec(this.imports)));
      if (this.funcs.length) out.push(...section(3, vec(this.funcs)));
      if (this.tables.length) out.push(...section(4, vec(this.tables)));
      if (this.mems.length) out.push(...section(5, vec(this.mems)));
      if (this.exports.length) out.push(...section(7, vec(this.exports)));
      if (this.start != null) out.push(...section(8, u(this.start)));
      if (this.elems.length) out.push(...section(9, vec(this.elems)));
      if (this.codes.length) out.push(...section(10, vec(this.codes)));
      if (this.datas.length) out.push(...section(11, vec(this.datas)));
      return new Uint8Array(out);
    }
  }

  return { T, KIND, OP, MB, u, s, str, vec };
});
