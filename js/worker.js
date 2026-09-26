// Web Worker：负责 wasm 实例化与所有计算，主线程只做渲染，保证不卡。
importScripts('wasm-bytes.js'); // 提供 WASM_B64 = { multi, single, bad }

// 与 wasm/build-wasm.mjs 中声明一致的元信息（max 无法通过 JS API 读取）
const META = {
  multi:  { memories: [{ name: 'mem0', max: 4 }, { name: 'mem1', max: 4 }],
            tables: [{ name: 't0', type: 'funcref', max: 8 }, { name: 't1', type: 'funcref', max: 8 }, { name: 'text', type: 'externref', max: 4 }] },
  single: { memories: [{ name: 'mem0', max: 4 }],
            tables: [{ name: 't0', type: 'funcref', max: 8 }] },
};

const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

let mode = null;       // 'multi' | 'single'
let instance = null;
let ex = null;
let fnNames = new Map();

function instantiate() {
  // 特性检测：multi-memory 不可用时降级到单内存单表模块
  try {
    const mod = new WebAssembly.Module(decode(WASM_B64.multi));
    instance = new WebAssembly.Instance(mod);
    mode = 'multi';
  } catch (e) {
    const fallbackError = `${e.constructor.name}: ${e.message}`;
    instance = new WebAssembly.Instance(new WebAssembly.Module(decode(WASM_B64.single)));
    mode = 'single';
    return { fallback: true, reason: fallbackError };
  }
  return { fallback: false };
}

function refreshFnNames() {
  ex = instance.exports;
  fnNames = new Map();
  for (const [k, v] of Object.entries(ex)) if (typeof v === 'function') fnNames.set(v, k);
}

function snapshot() {
  const meta = META[mode];
  const memories = meta.memories.map((m) => {
    const mem = ex[m.name];
    const buf = new Uint8Array(mem.buffer);
    return {
      name: m.name,
      pages: mem.buffer.byteLength / 65536,
      maxPages: m.max,
      bytes: mem.buffer.byteLength,
      sample: Array.from(buf.subarray(0, 512)), // TypedArray 采样，供热力图
    };
  });
  const tables = meta.tables.map((t) => {
    const tbl = ex[t.name];
    const entries = [];
    for (let i = 0; i < tbl.length; i++) {
      const v = tbl.get(i);
      if (v === null) entries.push({ kind: 'null', label: 'null' });
      else if (typeof v === 'function') entries.push({ kind: 'func', label: fnNames.get(v) || 'fn' });
      else entries.push({ kind: 'extern', label: (v && v.note) || typeof v });
    }
    return { name: t.name, type: t.type, length: tbl.length, max: t.max, entries };
  });
  return { mode, memories, tables };
}

const ok = (id, result, extra = {}) => postMessage({ id, ok: true, result, state: snapshot(), ...extra });
const fail = (id, e, extra = {}) =>
  postMessage({ id, ok: false, error: { name: e.constructor.name, message: e.message }, state: instance ? snapshot() : null, ...extra });

// 包装：捕获 wasm trap / JS 异常并回传
function run(id, fn) {
  try { fn(); } catch (e) { fail(id, e); }
}

const OPS = {
  // ---- 内存操作 ----
  fillPattern0() { for (let s = 0; s < 8; s++) ex.fill0(256 + s * 56, 48, 0x20 + s * 0x1c); },
  fillPattern1() { for (let s = 0; s < 8; s++) ex.fill1(256 + s * 56, 48, 0xe0 - s * 0x1c); },
  copy01() { ex.copy01(1024, 256, 448); return 'mem0[256..704] -> mem1[1024..1472]，共 448 字节'; },
  copy10() { ex.copy10(2048, 1024, 448); return 'mem1[1024..1472] -> mem0[2048..2496]，共 448 字节'; },
  growMem0() { const r = ex.growMem0(1); if (r === -1) throw new Error('mem0 增长失败：已达最大值 4 页（memory.grow 返回 -1）'); return `mem0: ${r} -> ${r + 1} 页`; },
  growMem1() { const r = ex.growMem1(1); if (r === -1) throw new Error('mem1 增长失败：已达最大值 4 页（memory.grow 返回 -1）'); return `mem1: ${r} -> ${r + 1} 页`; },
  oobRead()  { ex.read0(ex.memSize0() * 65536); },          // 必 trap
  oobWrite() { ex.write1(ex.memSize1() * 65536, 0xdead); }, // 必 trap

  // ---- 表操作 ----
  copyT0toT1() { ex.copyT0toT1(0, 0, 2); return 'table.copy: t0[0..2] -> t1[0..2]（跨表函数引用）'; },
  callT0() { return `call_indirect t0[0](6,7) = ${ex.callT0(0, 6, 7)}，t0[1](6,7) = ${ex.callT0(1, 6, 7)}`; },
  callT1() { return `call_indirect t1[0](6,7) = ${ex.callT1(0, 6, 7)}，t1[1](6,7) = ${ex.callT1(1, 6, 7)}`; },
  callT0Wrong() { ex.callT0Wrong(0, 1, 2); }, // 期望 (i32)->i32，实际 (i32,i32)->i32 → 运行时签名不匹配
  growTable0() { const r = ex.growTable0(1); if (r === -1) throw new Error('t0 增长失败：已达最大值 8 项（table.grow 返回 -1）'); return `t0: ${r} -> ${r + 1} 项（填充 ref.func $add）`; },
  growTable1() { const r = ex.growTable1(1); if (r === -1) throw new Error('t1 增长失败：已达最大值 8 项（table.grow 返回 -1）'); return `t1: ${r} -> ${r + 1} 项（填充 ref.func $add）`; },
  tableOOB() { ex.t0.get(ex.t0.length); }, // RangeError
  refMismatch() {
    const results = [];
    try { ex.t0.set(0, { note: 'plain object' }); results.push('t0.set(普通对象) 未被拒绝?!'); }
    catch (e) { results.push(`t0(funcref).set(普通对象) 被拒绝 [${e.constructor.name}]: ${e.message}`); }
    if (mode === 'multi') {
      ex.text.set(0, { note: 'externref 对象' });
      results.push('text(externref).set(普通对象) 成功 ✓');
    }
    return results.join('\n');
  },

  // ---- 系统 ----
  instantiateFail() {
    const results = [];
    try { new WebAssembly.Instance(new WebAssembly.Module(decode(WASM_B64.bad)), { env: {} }); }
    catch (e) { results.push(`缺失 import env.missing [${e.constructor.name}]: ${e.message}`); }
    try { new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 9, 9, 9, 9])); }
    catch (e) { results.push(`损坏的字节 [${e.constructor.name}]: ${e.message}`); }
    return results.join('\n');
  },
  stress() {
    const t0 = performance.now();
    const pages0 = ex.memSize0(), pages1 = mode === 'multi' ? ex.memSize1() : 0;
    for (let i = 0; i < 300; i++) {
      ex.fill0(0, pages0 * 65536, i & 0xff);
      if (mode === 'multi') { ex.fill1(0, pages1 * 65536, 255 - (i & 0xff)); ex.copy01(0, 0, 65536); ex.copy10(0, 0, 65536); }
    }
    return `300 轮 fill+copy 耗时 ${(performance.now() - t0).toFixed(1)}ms（在 Worker 中执行，主线程应保持流畅）`;
  },
};

onmessage = (ev) => {
  const { id, cmd } = ev.data;
  if (cmd === 'init') {
    try {
      const info = instantiate();
      refreshFnNames();
      ok(id, info.fallback ? `当前环境不支持 multi-memory，已降级到单内存单表（${info.reason}）` : 'multi-memory / multi-table 已启用', info);
    } catch (e) { fail(id, e); }
    return;
  }
  if (cmd === 'reset') {
    run(id, () => { instantiate(); refreshFnNames(); ok(id, '已重新实例化'); });
    return;
  }
  const op = OPS[cmd];
  if (!op) { fail(id, new Error(`未知命令: ${cmd}`)); return; }
  run(id, () => ok(id, op() || '完成'));
};
