/* test-node.js — 在 Node 中验证 wasm 模块行为（浏览器 UI 之外的逻辑自检测） */
'use strict';
const M = require('./modules.js');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  if (!cond) failures++;
}

(async () => {
  // ---------- 多内存多表模块 ----------
  const multiBytes = M.buildMainModule(true);
  check('multi: validate', WebAssembly.validate(multiBytes));
  const exp = (await WebAssembly.instantiate(multiBytes)).instance.exports;

  // 内存间拷贝
  const ua = new Uint8Array(exp.memA.buffer);
  for (let i = 0; i < 16; i++) ua[i] = 0x40 + i;
  exp.copyAtoB(0, 0, 16);
  const ub = new Uint8Array(exp.memB.buffer, 0, 16);
  check('multi: memory.copy A->B', ub[0] === 0x40 && ub[15] === 0x4f, `B[0]=0x${ub[0].toString(16)}`);
  exp.fillB(32, 8, 0xcd);
  check('multi: memory.fill B', new Uint8Array(exp.memB.buffer, 32, 1)[0] === 0xcd);
  exp.copyBtoA(64, 32, 8);
  check('multi: memory.copy B->A', exp.readA(64) === 0xcd);

  // 跨表调用：t1[0]=dispatch -> t0[sel]
  check('multi: callT1 dispatch->add', exp.callT1(0, 0) === 13, String(exp.callT1(0, 0)));
  check('multi: callT1 dispatch->mul', exp.callT1(0, 1) === 42, String(exp.callT1(0, 1)));
  check('multi: callT0 direct', exp.callT0(1, 6, 7) === 42);

  // 跨表引用复制
  exp.growT1(2); // t1: 1 -> 3
  exp.copyT0toT1(1, 0, 2);
  check('multi: table.copy t0->t1', exp.t1.get(1) === exp.add && exp.t1.get(2) === exp.mul);
  exp.moveT0toT1(0, 0);
  check('multi: table.get/set 跨表移动', exp.t1.get(0) === exp.add);

  // 内存增长
  check('multi: growA ok', exp.growA(1) === 1 && exp.sizeA() === 2);
  check('multi: growB to max', exp.growB(1) === 1 && exp.sizeB() === 2);
  check('multi: growB 失败(-1)', exp.growB(1) === -1);
  while (exp.growA(1) !== -1) {}
  check('multi: growA 到上限 4 页后失败', exp.sizeA() === 4);

  // 表增长
  while (exp.growT0(1) !== -1) {}
  check('multi: t0 增长到上限 8', exp.sizeT0() === 8 && exp.growT0(1) === -1);
  check('multi: t0 增长槽位被 add 填充', exp.t0.get(7) === exp.add && exp.t0IsNull(7) === 0);

  // 越界读取
  let msg = '';
  try { exp.readA(exp.sizeA() * 65536); } catch (e) { msg = e.message; }
  check('multi: 越界读取被捕获', /out of bounds/i.test(msg), msg);

  // 越界间接调用
  msg = '';
  try { exp.callT0(99, 1, 2); } catch (e) { msg = e.message; }
  check('multi: 越界调用被捕获', msg.length > 0, msg);

  // 运行时签名不匹配
  exp.t0.set(0, exp.square);
  msg = '';
  try { exp.callT0(0, 7, 6); } catch (e) { msg = e.message; }
  check('multi: 签名不匹配被捕获', /signature|mismatch/i.test(msg), msg);
  exp.t0.set(0, exp.add);

  // JS 侧引用类型
  msg = '';
  try { exp.t0.set(0, { nope: 1 }); } catch (e) { msg = e.message; }
  check('multi: funcref 表拒绝非函数', msg.length > 0, msg);
  exp.t2.set(0, { hello: 'world' });
  check('multi: externref 表接受任意 JS 值', exp.t2.get(0).hello === 'world');

  // ---------- 降级模块 ----------
  const fbBytes = M.buildMainModule(false);
  check('fallback: validate', WebAssembly.validate(fbBytes));
  const fb = (await WebAssembly.instantiate(fbBytes)).instance.exports;
  check('fallback: memA===memB（共享单内存）', fb.memA === fb.memB);
  check('fallback: t0===t1（共享单表）', fb.t0 === fb.t1);
  check('fallback: dispatch 同表间接调用', fb.callT1(2, 1) === 42, String(fb.callT1(2, 1)));
  const fa = new Uint8Array(fb.memA.buffer);
  for (let i = 0; i < 8; i++) fa[i] = 0x50 + i;
  fb.copyAtoB(0x8000, 0, 8);
  check('fallback: 单内存内拷贝', fb.readB(0x8000) === 0x50 && fb.readB(0x8007) === 0x57);

  // ---------- 失败演示模块 ----------
  msg = ''; let ctor = '';
  try { await WebAssembly.instantiate(M.buildBadImportModule(), {}); } catch (e) { msg = e.message; ctor = e.constructor.name; }
  check('bad-import: 实例化失败(LinkError/TypeError)', ctor === 'LinkError' || ctor === 'TypeError', `${ctor}: ${msg}`);

  msg = ''; ctor = '';
  try { await WebAssembly.instantiate(M.buildStartTrapModule()); } catch (e) { msg = e.message; ctor = e.constructor.name; }
  check('start-trap: 实例化失败(RuntimeError)', ctor === 'RuntimeError', `${ctor}: ${msg}`);

  msg = ''; ctor = '';
  try { await WebAssembly.compile(M.buildBadRefTypeModule()); } catch (e) { msg = e.message; ctor = e.constructor.name; }
  check('bad-reftype: 编译期类型不匹配(CompileError)', ctor === 'CompileError', `${ctor}: ${msg}`);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
