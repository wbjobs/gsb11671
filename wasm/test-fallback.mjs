// 模拟不支持 multi-memory 的环境：破坏 multi 字节，验证降级到 single。运行: node wasm/test-fallback.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));

const responses = [];
globalThis.postMessage = (msg) => responses.push(msg);
let bytesSrc = readFileSync(join(dir, '..', 'js', 'wasm-bytes.js'), 'utf8');
// 把 multi 模块的版本号改坏，模拟 "multi-memory 不支持 -> 编译失败"
bytesSrc = bytesSrc.replace(/multi: '([A-Za-z0-9+/=]+)'/, (_, b) => {
  const bin = Buffer.from(b, 'base64'); bin[4] = 0xee;
  return `multi: '${bin.toString('base64')}'`;
});
const workerSrc = readFileSync(join(dir, '..', 'js', 'worker.js'), 'utf8')
  .replace(/^importScripts.*$/m, '')
  .replace('onmessage =', 'globalThis.onmessage =');
eval(bytesSrc + '\n' + workerSrc);

let passed = 0, failed = 0;
const ok = (c, n, x = '') => { c ? passed++ : failed++; console.log(c ? 'PASS' : 'FAIL', n, x); };
const send = (cmd) => { responses.length = 0; onmessage({ data: { id: 1, cmd } }); return responses[0]; };

const r = send('init');
ok(r.ok && r.state.mode === 'single', 'multi 不可用时降级到 single', r.result);
ok(r.state.memories.length === 1 && r.state.tables.length === 1, 'single 快照: 1 内存 1 表');
ok(send('fillPattern0').ok, 'single: fillPattern0');
ok(send('copy01').ok, 'single: copy01（mem0 内拷贝）');
ok(send('growMem0').ok, 'single: growMem0');
ok(send('callT0').ok, 'single: callT0');
ok(!send('callT0Wrong').ok, 'single: 错误签名仍被捕获');
ok(!send('oobRead').ok, 'single: 越界读仍被捕获');
ok(!send('fillPattern1').ok, 'single: mem1 命令报错（UI 中会禁用）');
ok(send('reset').ok, 'single: reset');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
