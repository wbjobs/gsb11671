// 手工编码 WebAssembly 二进制：
//  - multi.wasm  : 2 个内存 + 3 个表（multi-memory / multi-table / reference-types）
//  - single.wasm : 1 个内存 + 1 个表（降级方案，导出名与 multi 兼容）
//  - bad.wasm    : 依赖缺失的 import，用于演示实例化失败（LinkError）
// 运行: node wasm/build-wasm.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 编码辅助 ----------
const lebU = (n) => {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};
const str = (s) => [...lebU(s.length), ...Array.from(s, (c) => c.charCodeAt(0))];
const section = (id, payload) => [id, ...lebU(payload.length), ...payload];
const vec = (items) => [...lebU(items.length), ...items.flat()];
const byteVec = (bytes) => [...lebU(bytes.length), ...bytes];
const flat = (items) => items.flat();

const I32 = 0x7f, FUNCREF = 0x70, EXTERNREF = 0x6f;
const funcType = (params, results) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];
const limits = (min, max) => [0x01, ...lebU(min), ...lebU(max)];
const i32const = (n) => [0x41, ...lebU(n)];
const end = 0x0b;

// 类型下标（两个模块共用同一份类型区）
// 0: (i32,i32)->i32   1: (i32)->i32   2: (i32,i32,i32)->()
// 3: (i32,i32)->()    4: ()->i32      5: (i32,i32,i32)->i32
const TYPES = [
  funcType([I32, I32], [I32]),
  funcType([I32], [I32]),
  funcType([I32, I32, I32], []),
  funcType([I32, I32], []),
  funcType([], [I32]),
  funcType([I32, I32, I32], [I32]),
];

const body = (expr) => {
  const code = [0x00, ...expr, end]; // 0 个局部变量组
  return [...lebU(code.length), ...code];
};
const lg = (i) => [0x20, i]; // local.get

// 各函数体（multi 版）
const B = {
  add:  body([...lg(0), ...lg(1), 0x6a]),
  mul:  body([...lg(0), ...lg(1), 0x6c]),
  // memory.copy <dstMem> <srcMem>，参数 (dstOff, srcOff, len)
  copy01: body([...lg(0), ...lg(1), ...lg(2), 0xfc, 0x0a, 0x01, 0x00]),
  copy10: body([...lg(0), ...lg(1), ...lg(2), 0xfc, 0x0a, 0x00, 0x01]),
  copy00: body([...lg(0), ...lg(1), ...lg(2), 0xfc, 0x0a, 0x00, 0x00]),
  // i32.store / i32.load：memarg 的 align 字段置 bit6(0x40) 表示后跟 memidx
  write0: body([...lg(0), ...lg(1), 0x36, 0x02, 0x00]),
  write1: body([...lg(0), ...lg(1), 0x36, 0x42, 0x01, 0x00]),
  read0:  body([...lg(0), 0x28, 0x02, 0x00]),
  read1:  body([...lg(0), 0x28, 0x42, 0x01, 0x00]),
  // call_indirect <typeIdx> <tableIdx>，参数 (idx, a, b)
  callT0:      body([...lg(1), ...lg(2), ...lg(0), 0x11, 0x00, 0x00]),
  callT1:      body([...lg(1), ...lg(2), ...lg(0), 0x11, 0x00, 0x01]),
  // 只压 1 个参数 + 下标，call_indirect 期望 (i32)->i32，而表项实际是 (i32,i32)->i32 → 运行时签名不匹配 trap
  callT0Wrong: body([...lg(1), ...lg(0), 0x11, 0x01, 0x00]),
  // table.copy <dstTable> <srcTable>（操作码 0xFC 0x0E）
  copyT0toT1: body([...lg(0), ...lg(1), ...lg(2), 0xfc, 0x0e, 0x01, 0x00]),
  growMem0: body([...lg(0), 0x40, 0x00]),
  growMem1: body([...lg(0), 0x40, 0x01]),
  // table.grow <tableIdx>：ref.func $add 作为填充值
  growTable0: body([0xd2, 0x00, ...lg(0), 0xfc, 0x0f, 0x00]),
  growTable1: body([0xd2, 0x00, ...lg(0), 0xfc, 0x0f, 0x01]),
  memSize0: body([0x3f, 0x00]),
  memSize1: body([0x3f, 0x01]),
  tableSize0: body([0xfc, 0x10, 0x00]),
  tableSize1: body([0xfc, 0x10, 0x01]),
  // memory.fill <memIdx>，参数 (dstOff, len, value)
  fill0: body([...lg(0), ...lg(2), ...lg(1), 0xfc, 0x0b, 0x00]),
  fill1: body([...lg(0), ...lg(2), ...lg(1), 0xfc, 0x0b, 0x01]),
};

const data0 = Array.from('MEM0> The quick brown fox 00', (c) => c.charCodeAt(0));
const data1 = Array.from('MEM1> jumps over the lazy dog 11', (c) => c.charCodeAt(0));

// ---------- multi.wasm ----------
// 函数: 0 add,1 mul,2 copy01,3 copy10,4 write0,5 write1,6 read0,7 read1,
//       8 callT0,9 callT1,10 callT0Wrong,11 copyT0toT1,12 growMem0,13 growMem1,
//       14 growTable0,15 growTable1,16 memSize0,17 memSize1,18 tableSize0,19 tableSize1,
//       20 fill0,21 fill1
const multiFuncTypes = [0, 0, 2, 2, 3, 3, 1, 1, 5, 5, 5, 2, 1, 1, 1, 1, 4, 4, 4, 4, 2, 2];
const multiCodes = [
  B.add, B.mul, B.copy01, B.copy10, B.write0, B.write1, B.read0, B.read1,
  B.callT0, B.callT1, B.callT0Wrong, B.copyT0toT1, B.growMem0, B.growMem1,
  B.growTable0, B.growTable1, B.memSize0, B.memSize1, B.tableSize0, B.tableSize1,
  B.fill0, B.fill1,
];
const multiExports = [
  ['add', 0, 0], ['mul', 0, 1], ['copy01', 0, 2], ['copy10', 0, 3],
  ['write0', 0, 4], ['write1', 0, 5], ['read0', 0, 6], ['read1', 0, 7],
  ['callT0', 0, 8], ['callT1', 0, 9], ['callT0Wrong', 0, 10], ['copyT0toT1', 0, 11],
  ['growMem0', 0, 12], ['growMem1', 0, 13], ['growTable0', 0, 14], ['growTable1', 0, 15],
  ['memSize0', 0, 16], ['memSize1', 0, 17], ['tableSize0', 0, 18], ['tableSize1', 0, 19],
  ['fill0', 0, 20], ['fill1', 0, 21],
  ['mem0', 2, 0], ['mem1', 2, 1],
  ['t0', 1, 0], ['t1', 1, 1], ['text', 1, 2],
];
const multi = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, vec(TYPES)),                                  // type
  ...section(3, vec(multiFuncTypes.map((t) => lebU(t)))),     // func
  ...section(4, vec([                                         // table
    [FUNCREF, ...limits(2, 8)],
    [FUNCREF, ...limits(2, 8)],
    [EXTERNREF, ...limits(1, 4)],
  ])),
  ...section(5, vec([limits(1, 4), limits(1, 4)])),           // memory x2
  ...section(7, vec(multiExports.map(([n, k, i]) => [...str(n), k, ...lebU(i)]))), // export
  ...section(9, vec([                                         // elem
    [0x00, ...i32const(0), end, ...vec([[0x00], [0x01]])],               // t0 <- [add, mul]
    [0x02, 0x01, ...i32const(0), end, 0x00, ...vec([[0x01], [0x00]])],   // t1 <- [mul, add]
  ])),
  ...section(10, vec(multiCodes)),                            // code
  ...section(11, vec([                                        // data
    [0x00, ...i32const(0), end, ...byteVec(data0)],                      // mem0
    [0x02, 0x01, ...i32const(0), end, ...byteVec(data1)],                // mem1
  ])),
];

// ---------- single.wasm（降级：单内存单表，导出名为 multi 的子集） ----------
// 函数: 0 add,1 mul,2 copy01(=mem0->mem0),3 write0,4 read0,5 callT0,
//       6 callT0Wrong,7 growMem0,8 growTable0,9 memSize0,10 tableSize0,11 fill0
const singleFuncTypes = [0, 0, 2, 3, 1, 5, 5, 1, 1, 4, 4, 2];
const singleCodes = [
  B.add, B.mul, B.copy00, B.write0, B.read0, B.callT0,
  B.callT0Wrong, B.growMem0, B.growTable0, B.memSize0, B.tableSize0, B.fill0,
];
const singleExports = [
  ['add', 0, 0], ['mul', 0, 1], ['copy01', 0, 2], ['write0', 0, 3], ['read0', 0, 4],
  ['callT0', 0, 5], ['callT0Wrong', 0, 6], ['growMem0', 0, 7], ['growTable0', 0, 8],
  ['memSize0', 0, 9], ['tableSize0', 0, 10], ['fill0', 0, 11],
  ['mem0', 2, 0], ['t0', 1, 0],
];
const single = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, vec(TYPES)),
  ...section(3, vec(singleFuncTypes.map((t) => lebU(t)))),
  ...section(4, vec([[FUNCREF, ...limits(2, 8)]])),
  ...section(5, vec([limits(1, 4)])),
  ...section(7, vec(singleExports.map(([n, k, i]) => [...str(n), k, ...lebU(i)]))),
  ...section(9, vec([[0x00, ...i32const(0), end, ...vec([[0x00], [0x01]])]])),
  ...section(10, vec(singleCodes)),
  ...section(11, vec([[0x00, ...i32const(0), end, ...byteVec(data0)]])),
];

// ---------- bad.wasm（import env.missing，用于实例化失败演示） ----------
const bad = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, vec([funcType([], [])])),
  ...section(2, vec([[...str('env'), ...str('missing'), 0x00, 0x00]])),
  ...section(3, vec([lebU(0)])),
  ...section(7, vec([[...str('run'), 0x00, 0x01]])),
  ...section(10, vec([body([0x10, 0x00])])),
];

// ---------- 输出 ----------
const toU8 = (a) => Uint8Array.from(a);
const b64 = (a) => Buffer.from(toU8(a)).toString('base64');
mkdirSync(join(root, 'wasm'), { recursive: true });
writeFileSync(join(root, 'wasm', 'multi.wasm'), toU8(multi));
writeFileSync(join(root, 'wasm', 'single.wasm'), toU8(single));
writeFileSync(join(root, 'wasm', 'bad.wasm'), toU8(bad));
writeFileSync(
  join(root, 'js', 'wasm-bytes.js'),
  `// 由 wasm/build-wasm.mjs 生成，请勿手改\n` +
  `const WASM_B64 = {\n  multi: '${b64(multi)}',\n  single: '${b64(single)}',\n  bad: '${b64(bad)}',\n};\n`
);
console.log('multi.wasm', multi.length, 'bytes');
console.log('single.wasm', single.length, 'bytes');
console.log('bad.wasm', bad.length, 'bytes');
console.log('js/wasm-bytes.js 已生成');
