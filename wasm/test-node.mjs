// 在 Node 中验证 multi/single/bad 三个模块的行为。运行: node wasm/test-node.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? passed++ : failed++; console.log(cond ? 'PASS' : 'FAIL', name); };
const throws = (fn, ErrType, name) => {
  try { fn(); ok(false, name + '（未抛错）'); }
  catch (e) { ok(e instanceof ErrType, `${name}（${e.constructor.name}: ${e.message}）`); }
};

const multiBytes = readFileSync(join(dir, 'multi.wasm'));
ok(WebAssembly.validate(multiBytes), 'multi.wasm 校验通过（multi-memory 支持）');
const ex = new WebAssembly.Instance(new WebAssembly.Module(multiBytes)).exports;

ok(ex.memSize0() === 1 && ex.memSize1() === 1, '初始内存各 1 页');
ok(ex.tableSize0() === 2 && ex.tableSize1() === 2, '初始表各 2 项');

// 内存间拷贝
const m0 = new Uint8Array(ex.mem0.buffer), m1 = new Uint8Array(ex.mem1.buffer);
const s0 = String.fromCharCode(...m0.slice(0, 5)), s1 = String.fromCharCode(...m1.slice(0, 5));
ok(s0 === 'MEM0>' && s1 === 'MEM1>', `数据段初始化（${s0} / ${s1}）`);
ex.copy01(64, 0, 28);
ok(String.fromCharCode(...m1.slice(64, 69)) === 'MEM0>', 'copy01: mem0 -> mem1');
ex.copy10(128, 0, 32);
ok(String.fromCharCode(...m0.slice(128, 133)) === 'MEM1>', 'copy10: mem1 -> mem0');

// 跨表函数引用
ok(ex.callT0(0, 3, 4) === 7 && ex.callT0(1, 3, 4) === 12, 'callT0: t0=[add,mul]');
ok(ex.callT1(0, 3, 4) === 12 && ex.callT1(1, 3, 4) === 7, 'callT1: t1=[mul,add]');
ex.copyT0toT1(0, 0, 2);
ok(ex.callT1(0, 3, 4) === 7, 'table.copy t0->t1 后 t1[0]=add');

// 间接调用签名不匹配
throws(() => ex.callT0Wrong(0, 1, 2), WebAssembly.RuntimeError, 'call_indirect 签名不匹配');

// 增长
ok(ex.growMem0(1) === 1 && ex.memSize0() === 2, 'mem0 增长 1 页');
ok(ex.growMem0(10) === -1, 'mem0 增长超过 max 返回 -1');
ok(ex.growTable0(2) === 2 && ex.tableSize0() === 4, 't0 增长 2 项');
ok(ex.t0.get(2) === ex.add, 't0 增长填充 ref.func add');
ok(ex.growTable0(100) === -1, 't0 增长超过 max 返回 -1');

// 越界
throws(() => ex.read0(ex.memSize0() * 65536), WebAssembly.RuntimeError, '内存越界读');
throws(() => ex.write1(4 * 65536, 1), WebAssembly.RuntimeError, '内存越界写');
throws(() => ex.t0.get(99), RangeError, '表越界 get');
throws(() => ex.callT0(7, 1, 2), WebAssembly.RuntimeError, '调用未初始化表项');

// 引用类型不匹配（JS 侧）
throws(() => ex.t0.set(0, {}), TypeError, 'funcref 表 set 普通对象');
ex.text.set(0, { tag: 'externref' });
ok(ex.text.get(0).tag === 'externref', 'externref 表 set 普通对象');
ex.t0.set(0, ex.mul);
ok(ex.callT0(0, 3, 4) === 12, 'funcref 表 set 导出函数');

// single 降级模块
const singleEx = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(dir, 'single.wasm')))).exports;
ok(singleEx.memSize0() === 1 && singleEx.memSize1 === undefined, 'single: 仅一个内存');
ok(singleEx.callT0(1, 3, 4) === 12, 'single: callT0 正常');
singleEx.fill0(0, 4, 0x41);
ok(new Uint8Array(singleEx.mem0.buffer)[0] === 0x41, 'single: fill0 正常');

// bad 模块实例化失败
throws(() => new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(dir, 'bad.wasm'))), { env: {} }), WebAssembly.LinkError, 'bad: 缺失 import -> LinkError');
throws(() => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 9, 9, 9, 9])), WebAssembly.CompileError, '损坏字节 -> CompileError');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
