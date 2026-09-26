/* worker.js — 所有 WebAssembly 工作都在 Worker 中执行，主线程只负责渲染。
 * 消息协议：
 *   接收: {type:'init'} | {type:'action', action}
 *   发送: {type:'log',level,msg} | {type:'state',state} | {type:'ready',mode,supported} | {type:'busy',busy}
 */
'use strict';
importScripts('wasm-enc.js', 'modules.js');

const M = WasmModules;
const L = M.LIMITS;

let exp = null;
let mode = null; // 'multi' | 'fallback'

const post = (msg, transfer) => postMessage(msg, transfer || []);
const log = (level, msg) => post({ type: 'log', level, msg });
const setBusy = (busy) => post({ type: 'busy', busy });

// ---------- 状态采集（TypedArray 视图 + transferable 采样） ----------
function memState(name, mem, maxPages, sharedWith) {
  const bytes = mem.buffer.byteLength;
  const sample = new Uint8Array(mem.buffer, 0, Math.min(256, bytes)).slice();
  return {
    name, maxPages, sharedWith: sharedWith || null,
    pages: bytes / 65536, bytes,
    sample: sample.buffer,
  };
}

function tableState(name, tbl, maxSize, sharedWith) {
  const entries = [];
  for (let i = 0; i < tbl.length; i++) {
    const v = tbl.get(i);
    let label = '';
    if (v !== null && v !== undefined) {
      if (v === exp.add) label = 'add';
      else if (v === exp.mul) label = 'mul';
      else if (v === exp.dispatch) label = 'dispatch';
      else if (v === exp.square) label = 'square';
      else label = typeof v === 'function' ? 'funcref' : 'externref';
    }
    entries.push({ label });
  }
  return { name, maxSize, sharedWith: sharedWith || null, size: tbl.length, entries };
}

function postState() {
  if (!exp) return;
  const multi = mode === 'multi';
  const mems = [
    memState('memA', exp.memA, L.MEM_A_MAX),
    memState('memB', exp.memB, multi ? L.MEM_B_MAX_MULTI : L.MEM_A_MAX, multi ? null : 'memA'),
  ];
  const tables = [
    tableState('t0', exp.t0, L.T0_MAX),
    tableState('t1', exp.t1, multi ? L.T1_MAX_MULTI : L.T0_MAX, multi ? null : 't0'),
    tableState('t2', exp.t2, L.T2_MAX),
  ];
  const transfers = mems.map((m) => m.sample);
  post({ type: 'state', state: { mode, mems, tables } }, transfers);
}

// ---------- 初始化：特性检测 + 实例化 + 降级 ----------
async function init() {
  setBusy(true);
  try {
    exp = null; mode = null;
    log('info', '—— 开始初始化：检测 multi-memory 支持 ——');
    const multiBytes = M.buildMainModule(true);
    let supported = false;
    try { supported = WebAssembly.validate(multiBytes); } catch (e) { supported = false; }

    if (supported) {
      try {
        exp = (await WebAssembly.instantiate(multiBytes)).instance.exports;
        mode = 'multi';
        log('ok', '多内存 + 多表模块实例化成功（memA/memB × t0/t1/t2）');
      } catch (e) {
        log('error', `多内存模块实例化失败：${e.message}，尝试降级…`);
      }
    } else {
      log('warn', '当前环境不支持 multi-memory（validate 失败），降级为单内存单表模块');
    }

    if (!exp) {
      try {
        exp = (await WebAssembly.instantiate(M.buildMainModule(false))).instance.exports;
        mode = 'fallback';
        log('warn', '已降级：单内存单表模块实例化成功（memB/t1 为同一对象的别名）');
      } catch (e) {
        log('error', `降级模块实例化也失败：${e.message}`);
        post({ type: 'ready', mode: 'none', supported });
        return;
      }
    }
    post({ type: 'ready', mode, supported });
    postState();
    log('info', `初始化完成，模式 = ${mode === 'multi' ? '多内存多表' : '降级（单内存单表）'}`);
  } finally {
    setBusy(false);
  }
}

// ---------- 各演示动作 ----------
const actions = {
  // 内存间拷贝 + 内存填充（TypedArray 写入 → wasm memory.copy → TypedArray 校验）
  copy() {
    const multi = mode === 'multi';
    const bBase = multi ? 0 : 0x8000;
    log('info', `内存间拷贝演示：TypedArray 写 memA → memory.copy → 读 memB（dst=0x${bBase.toString(16)}）`);
    const ua = new Uint8Array(exp.memA.buffer); // TypedArray 直写 wasm 内存
    for (let i = 0; i < 16; i++) ua[i] = 0x40 + i;
    exp.copyAtoB(bBase, 0, 16);
    const ub = new Uint8Array(exp.memB.buffer, bBase, 16);
    const hex = [...ub].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const okCopy = ub[0] === 0x40 && ub[15] === 0x4f;
    log(okCopy ? 'ok' : 'error', `memory.copy A→B ${okCopy ? '成功' : '校验失败'}：memB[${bBase}..] = ${hex}`);
    exp.fillA(32, 8, 0xab);
    exp.fillB(bBase + 32, 4, 0xcd);
    const okFill = exp.readA(32) === 0xab && exp.readB(bBase + 32) === 0xcd;
    log(okFill ? 'ok' : 'error', `memory.fill ${okFill ? '成功' : '失败'}：memA[32]=0xab, memB[${bBase + 32}]=0xcd`);
    exp.copyBtoA(64, bBase + 32, 4);
    log(exp.readA(64) === 0xcd ? 'ok' : 'error', `memory.copy B→A 回拷校验：memA[64]=0x${exp.readA(64).toString(16)}`);
    postState();
  },

  // 跨表函数引用：t1[0]=dispatch → call_indirect t0；table.copy / table.get+set 跨表移动
  cross() {
    const multi = mode === 'multi';
    const dispatchIdx = multi ? 0 : 2;
    log('info', `跨表函数引用演示：callT1(${dispatchIdx}, sel) → t1[dispatch] → call_indirect t0[sel](7,6)`);
    const rAdd = exp.callT1(dispatchIdx, 0);
    const rMul = exp.callT1(dispatchIdx, 1);
    log(rAdd === 13 ? 'ok' : 'error', `跨表链式调用 t1→t0[add](7,6) = ${rAdd}（期望 13）`);
    log(rMul === 42 ? 'ok' : 'error', `跨表链式调用 t1→t0[mul](7,6) = ${rMul}（期望 42）`);

    const dst = multi ? 1 : 3;
    const need = dst + 2 - exp.sizeT1();
    if (need > 0) {
      const r = exp.growT1(need);
      log(r === -1 ? 'warn' : 'info', `为跨表复制增长 t1：${r === -1 ? '失败（上限）' : `size ${r} → ${exp.sizeT1()}`}`);
    }
    try {
      exp.copyT0toT1(dst, 0, 2); // table.copy：t0[0..2) → t1[dst..dst+2)
      const okRef = exp.t1.get(dst) === exp.add && exp.t1.get(dst + 1) === exp.mul;
      log(okRef ? 'ok' : 'error', `table.copy t0→t1 ${okRef ? '成功' : '校验失败'}：t1[${dst}]=add, t1[${dst + 1}]=mul（JS 侧引用同一性校验通过）`);
    } catch (e) {
      log('error', `table.copy 失败：${e.message}`);
    }
    const dst2 = multi ? 3 : 5; // 独立槽位，避免覆盖 t1[0]=dispatch
    const need2 = dst2 + 1 - exp.sizeT1();
    if (need2 > 0 && exp.growT1(need2) === -1) log('warn', 't1 已达上限，跳过跨表移动');
    if (exp.sizeT1() > dst2) {
      try {
        exp.moveT0toT1(0, dst2); // table.get t0 + table.set t1
        log(exp.t1.get(dst2) === exp.add ? 'ok' : 'error',
          `table.get(t0) + table.set(t1) 跨表移动：t1[${dst2}] = add`);
      } catch (e) {
        log('error', `跨表移动失败：${e.message}`);
      }
    }
    postState();
  },

  growMemA() { growMem('memA', () => exp.sizeA(), (n) => exp.growA(n)); },
  growMemB() { growMem('memB', () => exp.sizeB(), (n) => exp.growB(n)); },
  growT0() { growTable('t0', () => exp.sizeT0(), (n) => exp.growT0(n)); },
  growT1() { growTable('t1', () => exp.sizeT1(), (n) => exp.growT1(n)); },

  oobRead() {
    const off = exp.sizeA() * 65536; // 恰好越界 1 字节
    log('info', `越界读取演示：readA(${off})（memA 共 ${exp.sizeA()} 页）`);
    try {
      exp.readA(off);
      log('error', '越界读取未被捕获（不应发生）');
    } catch (e) {
      log('ok', `越界读取已被 wasm 陷阱捕获：${e.constructor.name}: ${e.message}`);
    }
  },

  oobCall() {
    const idx = exp.sizeT0() + 5;
    log('info', `越界间接调用演示：callT0(${idx}, …)（t0 共 ${exp.sizeT0()} 项）`);
    try {
      exp.callT0(idx, 1, 2);
      log('error', '越界调用未被捕获（不应发生）');
    } catch (e) {
      log('ok', `越界间接调用已被捕获：${e.constructor.name}: ${e.message}`);
    }
  },

  // 运行时签名不匹配：把 (i32)->i32 的 square 放进要求 (i32,i32)->i32 的 t0 再调用
  sigMismatch() {
    log('info', '签名不匹配演示：t0.set(0, square) 后按 (i32,i32)->i32 调用');
    const saved = exp.t0.get(0);
    try {
      exp.t0.set(0, exp.square);
      exp.callT0(0, 7, 6);
      log('error', '签名不匹配未被捕获（不应发生）');
    } catch (e) {
      log('ok', `运行时签名不匹配已被捕获：${e.constructor.name}: ${e.message}`);
    } finally {
      exp.t0.set(0, saved); // 恢复
      log('info', '已恢复 t0[0] = add');
    }
    postState();
  },

  // JS 侧引用类型不匹配：funcref 表拒绝普通 JS 对象；externref 表接受任意 JS 值
  refMismatch() {
    log('info', 'JS 引用类型演示：向 funcref 表写普通对象 / 向 externref 表写对象');
    try {
      exp.t0.set(0, { not: 'a function' });
      log('error', 'funcref 表接受了非函数引用（不应发生）');
    } catch (e) {
      log('ok', `funcref 表拒绝非函数引用：${e.constructor.name}: ${e.message}`);
    }
    try {
      exp.t2.set(0, { hello: 'world', ts: Date.now() });
      log('ok', 'externref 表接受任意 JS 值：t2[0] = {hello:"world", …}');
    } catch (e) {
      log('error', `externref 表写入失败：${e.message}`);
    }
    postState();
  },

  // 实例化失败演示：缺少导入 / start 函数陷阱
  async instFail() {
    log('info', '实例化失败演示（1/2）：模块导入 env.missing，但不提供该导入');
    try {
      await WebAssembly.instantiate(M.buildBadImportModule(), { env: {} });
      log('error', '缺少导入的模块竟实例化成功（不应发生）');
    } catch (e) {
      log('ok', `实例化失败已捕获：${e.constructor.name}: ${e.message}`);
    }
    log('info', '实例化失败演示（2/2）：start 函数执行 unreachable');
    try {
      await WebAssembly.instantiate(M.buildStartTrapModule());
      log('error', 'start 陷阱模块竟实例化成功（不应发生）');
    } catch (e) {
      log('ok', `实例化失败已捕获：${e.constructor.name}: ${e.message}`);
    }
  },

  // 编译期引用类型不匹配：funcref 写入 externref 表
  compileFail() {
    log('info', '编译期类型不匹配演示：模块把 ref.func（funcref）写入 externref 表');
    try {
      new WebAssembly.Module(M.buildBadRefTypeModule());
      log('error', '非法模块竟编译通过（不应发生）');
    } catch (e) {
      log('ok', `编译期校验拒绝（引用类型不匹配）：${e.constructor.name}: ${e.message}`);
    }
  },

  // 压力测试：Worker 内高负载间接调用，主线程应保持流畅
  stress() {
    log('info', '压力测试：Worker 内执行约 2 秒 wasm 间接调用循环，请观察主线程 FPS');
    setBusy(true);
    const end = Date.now() + 2000;
    let rounds = 0, acc = 0;
    while (Date.now() < end) {
      for (let i = 0; i < 50000; i++) acc += exp.callT0(0, i & 7, 3);
      rounds++;
    }
    log('ok', `压力测试完成：${rounds} 轮 × 5 万次间接调用，校验值=${acc}（主线程未被阻塞）`);
    setBusy(false);
  },
};

function growMem(name, sizeFn, growFn) {
  const before = sizeFn();
  const r = growFn(1);
  if (r === -1) log('error', `${name} 增长失败：已达最大上限（memory.grow 返回 -1），当前 ${before} 页`);
  else log('ok', `${name} 增长成功：${before} → ${sizeFn()} 页（旧大小=${r}）`);
  postState();
}

function growTable(name, sizeFn, growFn) {
  const before = sizeFn();
  const r = growFn(1);
  if (r === -1) log('error', `${name} 增长失败：已达最大上限（table.grow 返回 -1），当前 ${before} 项`);
  else log('ok', `${name} 增长成功：${before} → ${sizeFn()} 项（旧大小=${r}）`);
  postState();
}

onmessage = async (e) => {
  const { type, action } = e.data || {};
  if (type === 'init') { await init(); return; }
  if (type === 'action') {
    if (!exp) { log('warn', '尚未初始化，请先点击「初始化 / 重新检测」'); return; }
    const fn = actions[action];
    if (fn) { try { await fn(); } catch (err) { log('error', `动作 ${action} 异常：${err.message}`); } }
  }
};
