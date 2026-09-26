// 主线程：只负责 UI 与 Canvas 渲染；所有 wasm 计算都在 Worker 中执行。
const worker = new Worker('js/worker.js');
const canvas = document.getElementById('viz');
const ctx = canvas.getContext('2d');
const logEl = document.getElementById('log');
const capEl = document.getElementById('cap');
const fpsEl = document.getElementById('fps');

let seq = 0;
const pending = new Map();
let lastState = null;
let mode = null;

worker.onmessage = (ev) => {
  const { id, ok: success, result, error, state, fallback } = ev.data;
  if (state) { lastState = state; mode = state.mode; render(); updateCap(fallback); updateButtons(); }
  const p = pending.get(id);
  if (p) { pending.delete(id); p(); }
  if (success) log(result, 'ok');
  else log(`[${error.name}] ${error.message}`, 'err');
};
worker.onerror = (e) => log(`Worker 错误: ${e.message}`, 'err');

function send(cmd) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    worker.postMessage({ id, cmd });
  });
}

function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}.${String(Date.now() % 1000).padStart(3, '0')}] ${msg}`;
  logEl.prepend(div);
  while (logEl.children.length > 120) logEl.lastChild.remove();
}

function updateCap(fallback) {
  if (mode === 'multi') { capEl.textContent = '✓ multi-memory / multi-table'; capEl.className = 'badge good'; }
  else if (mode === 'single') { capEl.textContent = '⚠ 降级：单内存单表'; capEl.className = 'badge warn'; }
}

// single 模式下禁用多内存/多表专属按钮
const MULTI_ONLY = ['fillPattern1', 'copy01', 'copy10', 'growMem1', 'oobWrite', 'copyT0toT1', 'callT1', 'growTable1', 'refMismatch'];
function updateButtons() {
  for (const btn of document.querySelectorAll('button[data-cmd]')) {
    const needMulti = MULTI_ONLY.includes(btn.dataset.cmd);
    btn.disabled = mode === null || (needMulti && mode !== 'multi');
  }
}

// ---------- Canvas 渲染 ----------
const PAGE = 65536;
function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawMemory(mem, x, y, w) {
  ctx.fillStyle = '#e8ecf1';
  ctx.font = 'bold 13px system-ui';
  ctx.fillText(`Memory "${mem.name}"`, x, y + 14);
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#667';
  ctx.fillText(`${mem.pages}/${mem.maxPages} 页 · ${(mem.bytes / 1024).toFixed(0)} KiB`, x + 130, y + 14);

  // 页块：已提交=实色，未提交=描边
  const bw = 34, gap = 6, py = y + 22;
  for (let p = 0; p < mem.maxPages; p++) {
    const px = x + p * (bw + gap);
    if (p < mem.pages) { ctx.fillStyle = '#3b82f6'; roundRect(px, py, bw, 22, 4); ctx.fill(); }
    else { ctx.strokeStyle = '#9aa4b2'; ctx.setLineDash([3, 3]); roundRect(px, py, bw, 22, 4); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = p < mem.pages ? '#fff' : '#9aa4b2';
    ctx.font = '10px system-ui';
    ctx.fillText(`p${p}`, px + 10, py + 15);
  }

  // 前 512 字节热力条（TypedArray 采样）
  const hy = py + 30, cell = Math.max(1, Math.floor((w - 0) / 64));
  for (let i = 0; i < 512; i++) {
    const v = mem.sample[i];
    ctx.fillStyle = v === 0 ? '#f1f4f8' : `hsl(${210 - (v / 255) * 190}, 85%, ${55 - (v / 255) * 12}%)`;
    ctx.fillRect(x + (i % 64) * cell, hy + Math.floor(i / 64) * 9, cell - 1, 8);
  }
  ctx.fillStyle = '#99a';
  ctx.font = '10px system-ui';
  ctx.fillText('前 512 字节（0=浅色）', x, hy + 8 * 9 + 12);
  return hy + 8 * 9 + 22;
}

function drawTable(tbl, x, y, w) {
  ctx.fillStyle = '#e8ecf1';
  ctx.font = 'bold 13px system-ui';
  ctx.fillText(`Table "${tbl.name}"`, x, y + 14);
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#667';
  ctx.fillText(`${tbl.type} · ${tbl.length}/${tbl.max} 项`, x + 110, y + 14);

  const bw = 64, gap = 6, ty = y + 22;
  for (let i = 0; i < tbl.max; i++) {
    const tx = x + i * (bw + gap);
    const e = tbl.entries[i];
    if (i >= tbl.length) {
      ctx.strokeStyle = '#9aa4b2'; ctx.setLineDash([3, 3]); roundRect(tx, ty, bw, 24, 4); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#9aa4b2';
    } else if (e.kind === 'null') {
      ctx.fillStyle = '#e2e8f0'; roundRect(tx, ty, bw, 24, 4); ctx.fill();
      ctx.fillStyle = '#94a3b8';
    } else if (e.kind === 'func') {
      ctx.fillStyle = '#22c55e'; roundRect(tx, ty, bw, 24, 4); ctx.fill();
      ctx.fillStyle = '#fff';
    } else {
      ctx.fillStyle = '#a855f7'; roundRect(tx, ty, bw, 24, 4); ctx.fill();
      ctx.fillStyle = '#fff';
    }
    ctx.font = '10px system-ui';
    const label = i >= tbl.length ? '—' : (e.label.length > 9 ? e.label.slice(0, 8) + '…' : e.label);
    ctx.fillText(`[${i}] ${label}`, tx + 4, ty + 16);
  }
  return ty + 34;
}

function render() {
  const { w, h } = fitCanvas();
  ctx.clearRect(0, 0, w, h);
  if (!lastState) {
    ctx.fillStyle = '#99a'; ctx.font = '14px system-ui';
    ctx.fillText('正在初始化 Worker…', 20, 30);
    return;
  }
  let y = 8;
  ctx.fillStyle = '#334155'; ctx.font = 'bold 14px system-ui';
  ctx.fillText(`模式: ${lastState.mode === 'multi' ? '多内存 × 多表' : '单内存 × 单表（降级）'}`, 12, y + 12);
  y += 26;
  for (const mem of lastState.memories) y = drawMemory(mem, 12, y, w - 24) + 10;
  for (const tbl of lastState.tables) y = drawTable(tbl, 12, y, w - 24) + 8;
}

// ---------- FPS（证明主线程不卡） ----------
let frames = 0, lastTick = performance.now();
function tick(now) {
  frames++;
  if (now - lastTick >= 1000) {
    fpsEl.textContent = `主线程 ${frames} FPS`;
    frames = 0; lastTick = now;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- 事件绑定 ----------
for (const btn of document.querySelectorAll('button[data-cmd]')) {
  btn.addEventListener('click', async () => {
    const cmd = btn.dataset.cmd;
    btn.disabled = true;
    await send(cmd);
    updateButtons();
  });
}

window.addEventListener('resize', render);

// ---------- 启动 ----------
(async () => {
  log('Worker 已启动，开始特性检测与实例化…');
  await send('init');
  log('就绪。点击左侧按钮执行操作。');
})();
