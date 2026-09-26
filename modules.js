/* modules.js — 构造演示用 wasm 模块字节码：
 *  - buildMainModule(true)  : 多内存 × 多表（memA/memB + t0/t1 funcref + t2 externref）
 *  - buildMainModule(false) : 降级版（单内存单 funcref 表，同名导出，API 形状一致）
 *  - buildBadImportModule   : 缺少导入 → 实例化 LinkError
 *  - buildStartTrapModule   : start 函数陷阱 → 实例化 RuntimeError
 *  - buildBadRefTypeModule  : funcref 写入 externref 表 → 编译期 CompileError（引用类型不匹配）
 */
(function (root, factory) {
  const enc = typeof module !== 'undefined' && module.exports ? require('./wasm-enc.js') : root.WasmEnc;
  const api = factory(enc);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WasmModules = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Enc) {
  'use strict';
  const { T, KIND, OP, MB } = Enc;

  function ascii(x) {
    const b = [];
    for (let i = 0; i < x.length; i++) b.push(x.charCodeAt(i));
    return b;
  }

  // 多内存模式下的常量（降级模式共用同一构建函数，仅索引/段不同）
  const MEM_A_MAX = 4;
  const MEM_B_MAX_MULTI = 2;
  const T0_MAX = 8;
  const T1_MAX_MULTI = 4;
  const T2_MAX = 2;

  function buildMainModule(multi) {
    const m = new MB();
    const memB = multi ? 1 : 0;      // 降级时 memB 复用内存 0
    const tbl1 = multi ? 1 : 0;      // 降级时 t1 复用表 0
    const tbl2 = multi ? 2 : 1;      // externref 表索引

    // ---- 类型 ----
    const tyBin = m.type([T.i32, T.i32], [T.i32]);      // (a,b)->r
    const tyUn = m.type([T.i32], [T.i32]);              // (a)->r
    const ty3v = m.type([T.i32, T.i32, T.i32], []);     // (a,b,c)->
    const tySize = m.type([], [T.i32]);                 // ()->r
    const tyCall0 = m.type([T.i32, T.i32, T.i32], [T.i32]); // (idx,a,b)->r
    const ty2v = m.type([T.i32, T.i32], []);            // (a,b)->

    // ---- 函数 ----
    const fAdd = m.func(tyBin, [], [...OP.lg(0), ...OP.lg(1), ...OP.i32add]);
    const fMul = m.func(tyBin, [], [...OP.lg(0), ...OP.lg(1), ...OP.i32mul]);
    const fSquare = m.func(tyUn, [], [...OP.lg(0), ...OP.lg(0), ...OP.i32mul]);
    // dispatch(sel)：通过表 0 间接调用 t0[sel](7, 6) —— 跨表调用的中间层
    const fDispatch = m.func(tyUn, [], [...OP.i32c(7), ...OP.i32c(6), ...OP.lg(0), ...OP.callInd(tyBin, 0)]);

    const fFillA = m.func(ty3v, [], [...OP.lg(0), ...OP.lg(2), ...OP.lg(1), ...OP.memFill(0)]);
    const fFillB = m.func(ty3v, [], [...OP.lg(0), ...OP.lg(2), ...OP.lg(1), ...OP.memFill(memB)]);
    const fCopyAB = m.func(ty3v, [], [...OP.lg(0), ...OP.lg(1), ...OP.lg(2), ...OP.memCopy(memB, 0)]);
    const fCopyBA = m.func(ty3v, [], [...OP.lg(0), ...OP.lg(1), ...OP.lg(2), ...OP.memCopy(0, memB)]);
    const fReadA = m.func(tyUn, [], [...OP.lg(0), ...OP.load8u(0)]);
    const fReadB = m.func(tyUn, [], [...OP.lg(0), ...OP.load8u(memB)]);
    const fSizeA = m.func(tySize, [], [...OP.memSize(0)]);
    const fSizeB = m.func(tySize, [], [...OP.memSize(memB)]);
    const fGrowA = m.func(tyUn, [], [...OP.lg(0), ...OP.memGrow(0)]);
    const fGrowB = m.func(tyUn, [], [...OP.lg(0), ...OP.memGrow(memB)]);

    const fCallT0 = m.func(tyCall0, [], [...OP.lg(1), ...OP.lg(2), ...OP.lg(0), ...OP.callInd(tyBin, 0)]);
    const fCallT1 = m.func(tyBin, [], [...OP.lg(1), ...OP.lg(0), ...OP.callInd(tyUn, tbl1)]);
    const fGrowT0 = m.func(tyUn, [], [...OP.refFunc(fAdd), ...OP.lg(0), ...OP.tblGrow(0)]);
    const fGrowT1 = m.func(tyUn, [], [...OP.refNull(T.funcref), ...OP.lg(0), ...OP.tblGrow(tbl1)]);
    const fSizeT0 = m.func(tySize, [], [...OP.tblSize(0)]);
    const fSizeT1 = m.func(tySize, [], [...OP.tblSize(tbl1)]);
    const fSizeT2 = m.func(tySize, [], [...OP.tblSize(tbl2)]);
    const fCopyT = m.func(ty3v, [], [...OP.lg(0), ...OP.lg(1), ...OP.lg(2), ...OP.tblCopy(tbl1, 0)]);
    const fMoveT = m.func(ty2v, [], [...OP.lg(1), ...OP.lg(0), ...OP.tblGet(0), ...OP.tblSet(tbl1)]);
    const fT0Null = m.func(tyUn, [], [...OP.lg(0), ...OP.tblGet(0), ...OP.refIsNull]);

    // ---- 表 ----
    m.table(T.funcref, multi ? 2 : 3, T0_MAX);                    // t0
    if (multi) m.table(T.funcref, 1, T1_MAX_MULTI);               // t1
    m.table(T.externref, 1, T2_MAX);                              // t2（降级时索引为 1）

    // ---- 内存 ----
    m.memory(1, MEM_A_MAX);                                       // memA
    if (multi) m.memory(1, MEM_B_MAX_MULTI);                      // memB

    // ---- 元素段 / 数据段 ----
    if (multi) {
      m.elemActive(0, OP.i32c(0), [fAdd, fMul]);
      m.elemActive(1, OP.i32c(0), [fDispatch]);
      m.dataActive(0, 0, ascii('HELLO-MEM-A!'));
      m.dataActive(1, 0, ascii('hello-mem-b!'));
    } else {
      m.elemActive(0, OP.i32c(0), [fAdd, fMul, fDispatch]);
      m.dataActive(0, 0, ascii('HELLO-MEM-A!'));
      m.dataActive(0, 0x8000, ascii('hello-mem-b!'));
    }

    // ---- 导出 ----
    m.export('memA', KIND.mem, 0);
    m.export('memB', KIND.mem, multi ? 1 : 0);
    m.export('t0', KIND.table, 0);
    m.export('t1', KIND.table, multi ? 1 : 0);
    m.export('t2', KIND.table, tbl2);
    const fns = {
      add: fAdd, mul: fMul, square: fSquare, dispatch: fDispatch,
      fillA: fFillA, fillB: fFillB, copyAtoB: fCopyAB, copyBtoA: fCopyBA,
      readA: fReadA, readB: fReadB, sizeA: fSizeA, sizeB: fSizeB,
      growA: fGrowA, growB: fGrowB,
      callT0: fCallT0, callT1: fCallT1,
      growT0: fGrowT0, growT1: fGrowT1,
      sizeT0: fSizeT0, sizeT1: fSizeT1, sizeT2: fSizeT2,
      copyT0toT1: fCopyT, moveT0toT1: fMoveT, t0IsNull: fT0Null,
    };
    for (const [name, idx] of Object.entries(fns)) m.export(name, KIND.func, idx);

    return m.bytes();
  }

  // 缺少导入 env.missing → 实例化时 LinkError
  function buildBadImportModule() {
    const m = new MB();
    const ty = m.type([], []);
    m.importFunc('env', 'missing', ty);
    return m.bytes();
  }

  // start 函数执行 unreachable → 实例化时 RuntimeError
  function buildStartTrapModule() {
    const m = new MB();
    const ty = m.type([], []);
    const f = m.func(ty, [], [...OP.unreachable]);
    m.setStart(f);
    return m.bytes();
  }

  // 把 funcref 写入 externref 表 → 编译期 CompileError（引用类型不匹配）
  function buildBadRefTypeModule() {
    const m = new MB();
    const ty = m.type([], []);
    const g = m.func(ty, [], []);
    m.table(T.externref, 1, 1);
    m.export('g', KIND.func, g); // 导出使 g 成为“已声明”函数，确保唯一错误是类型不匹配
    m.func(ty, [], [...OP.i32c(0), ...OP.refFunc(g), ...OP.tblSet(0)]);
    return m.bytes();
  }

  return {
    buildMainModule,
    buildBadImportModule,
    buildStartTrapModule,
    buildBadRefTypeModule,
    LIMITS: { MEM_A_MAX, MEM_B_MAX_MULTI, T0_MAX, T1_MAX_MULTI, T2_MAX },
  };
});
