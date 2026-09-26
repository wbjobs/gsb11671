// 在 Node 中模拟 Worker 全局环境，对 js/worker.js 做冒烟测试。运行: node wasm/test-worker.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));

// 模拟 Worker 全局（拼接 wasm-bytes.js + worker.js 一次 eval，等价于 importScripts）
const responses = [];
globalThis.postMessage = (msg) => responses.push(msg);
const bytesSrc = readFileSync(join(dir, '..', 'js', 'wasm-bytes.js'), 'utf8');
const workerSrc = readFileSync(join(dir, '..', 'js', 'worker.js'), 'utf8')
  .replace(/^importScripts.*$/m, '')
  .replace('onmessage =', 'globalThis.onmessage =');
eval(bytesSrc + '\n' + workerSrc);

let passed = 0, failed = 0;
const send = (cmd) => {
  responses.length = 0;
  onmessage({ data: { id: 1, cmd } });
  return responses[0];
};
const ok = (cond, name, extra = '') => { cond ? passed++ : failed++; console.log(cond ? 'PASS' : 'FAIL', name, extra); };

// init
let r = send('init');
ok(r.ok && r.state.mode === 'multi', 'init: multi 模式', r.result);
ok(r.state.memories.length === 2 && r.state.tables.length === 3, '快照含 2 内存 3 表');
ok(r.state.memories[0].sample.length === 512, 'TypedArray 采样 512 字节');
ok(r.state.tables[0].entries.map(e => e.label).join(',') === 'add,mul', 't0 初始 [add,mul]');
ok(r.state.tables[1].entries.map(e => e.label).join(',') === 'mul,add', 't1 初始 [mul,add]');

const expectOk = (cmd, name) => { const r = send(cmd); ok(r.ok, `${name}${r.ok ? '（' + String(r.result).split('\n')[0] + '）' : '：' + r.error.message}`); return r; };
const expectFail = (cmd, name) => { const r = send(cmd); ok(!r.ok, `${name} [${r.error.name}] ${r.error.message.split('\n')[0]}`); return r; };

expectOk('fillPattern0', '填充 mem0 图案');
expectOk('fillPattern1', '填充 mem1 图案');
r = expectOk('copy01', '拷贝 mem0->mem1');
ok(r.state.memories[1].sample[512 - 512 + 0] !== undefined, '快照正常返回');
expectOk('copy10', '拷贝 mem1->mem0');
expectOk('growMem0', 'mem0 增长');
expectOk('growMem1', 'mem1 增长');
expectOk('growMem0', 'mem0 再增长');
expectOk('growMem0', 'mem0 第三次增长(到 max)');
expectFail('growMem0', 'mem0 超过 max 增长失败');
expectOk('copyT0toT1', '跨表复制 t0->t1');
r = send('callT1');
ok(r.ok && r.result.includes('= 13'), '跨表复制后 t1[0]=add（6+7=13）', r.result);
expectOk('callT0', '间接调用 t0');
expectFail('callT0Wrong', '错误签名间接调用被捕获');
expectOk('growTable0', 't0 增长');
expectOk('growTable1', 't1 增长');
expectFail('tableOOB', '表越界被捕获');
expectFail('oobRead', '内存越界读被捕获');
expectFail('oobWrite', '内存越界写被捕获');
r = expectOk('refMismatch', '引用类型不匹配演示');
ok(r.result.includes('TypeError'), 'funcref 表拒绝普通对象');
ok(r.result.includes('成功'), 'externref 表接受普通对象');
ok(r.state.tables[2].entries[0].kind === 'extern', 'text[0] 显示 externref');
r = expectOk('instantiateFail', '实例化失败演示');
ok(r.result.includes('LinkError') && r.result.includes('CompileError'), 'LinkError + CompileError 均被捕获');
expectOk('stress', '压力测试');
r = expectOk('reset', '重置实例');
ok(r.state.memories[0].pages === 1 && r.state.tables[0].length === 2, '重置后回到初始状态');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
