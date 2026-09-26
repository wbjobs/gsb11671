/* main.js — 主线程：UI、Canvas 状态可视化、FPS 监控。所有 wasm 工作在 Worker 中。 */
'use strict';

const worker = new Worker('worker.js');
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const logEl = document.getElementById('log');
const fpsEl = document.getElementById('fps');
const badgeSupport = document.getElementById('badge-support');
const badgeMode = document.getElementById('badge-mode');
const badgeBusy = document.getElementById('badge-busy');

let lastState = null;

// ---------- Worker 消息 ----------
worker.onmessage = (e) => {
  const { type } = e.data;
  if (type === 'log') appendLog(e.data.level, e.data.msg);
  else if (type === 'state') { lastState = e.data.state; render(lastState); }
  else if (type === 'ready') {
    badgeSupport.textContent = 'multi-memory: ' + (e.data.supported ? '支持 ✓' : '不支持 ✗');
    badgeSupport.className = 'badge ' + (e.data.supported ? 'ok' : 'warn');
    badgeMode.textContent = '模式: ' + (e.data.mode === 'multi' ? '多内存 × 多表' : e.data.mode === 'fallback' ? '降级（单内存单表）' : '初始化失败');
    badgeMode.className = 'badge ' + (e.data.mode === 'multi' ? 'ok' : 'warn');
  } else if (type === 'busy') {
    badgeBusy.textContent = e.data.busy ? 'Worker: 忙' : 'Worker: 空闲';
    badgeBusy.className = 'badge ' + (e.data.busy ? 'warn' : 'ok');
  }
};
worker.onerror = (e) => appendLog('error', `Worker 错误: ${e.message}`);

// ---------- 日志 ----------
function appendLog(level, msg) {
  const div = document.createElement('div');
  div.className = 'entry ' + level;
  const t = new Date();
  const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
    + '.' + String(t.getMilliseconds()).padStart(3, '0');
  div.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- 按钮 ----------
const ACTIONS = [
  ['init', '初始化 / 重新检测', true],
  ['copy', '内存间拷贝 + 填充'],
  ['cross', '跨表函数引用'],
  ['growMemA', 'memA 增长一页'],
  ['growMemB', 'memB 增长一页'],
  ['growT0', 't0 增长一项'],
  ['growT1', 't1 增长一项'],
  ['oobRead', '越界读取（应捕获）'],
  ['oobCall', '越界调用（应捕获）'],
  ['sigMismatch', '签名不匹配（应捕获）'],
  ['refMismatch', 'JS 引用类型演示'],
  ['instFail', '实例化失败演示'],
  ['compileFail', '编译期类型不匹配'],
  ['stress', '压力测试 2s（看 FPS）'],
];
const controls = document.getElementById('controls');
for (const [action, label, isInit] of ACTIONS) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.dataset.action = action;
  if (isInit) btn.classList.add('primary');
  btn.onclick = () => {
    if (action === 'init') worker.postMessage({ type: 'init' });
    else worker.postMessage({ type: 'action', action });
  };
  controls.appendChild(btn);
}
document.getElementById('clearLog').onclick = () => { logEl.innerHTML = ''; };

// ---------- FPS 监控（证明主线程不卡） ----------
let lastT = performance.now(), fps = 60;
(function loop(t) {
  const dt = t - lastT; lastT = t;
  fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;
  fpsEl.textContent = fps.toFixed(0);
  fpsEl.className = 'fps ' + (fps > 50 ? 'ok' : fps > 30 ? 'warn' : 'err');
  requestAnimationFrame(loop);
})(performance.now());

// ---------- Canvas 渲染 ----------
const C = {
  bg: '#0d1117', panel: '#161b22', border: '#30363d', text: '#c9d1d9',
  dim: '#8b949e', ok: '#3fb950', warn: '#d29922', err: '#f85149',
  cell0: '#161b22', accent: '#58a6ff',
};

function render(state) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!state) { drawText('等待初始化…', 20, 30, C.dim, 14); return; }
  let y = 14;
  y = drawMemories(state, y) + 18;
  y = drawTables(state, y) + 10;
}

function drawText(s, x, y, color, size, bold) {
  ctx.fillStyle = color;
  ctx.font = `${bold ? 'bold ' : ''}${size || 12}px ui-monospace, Consolas, monospace`;
  ctx.fillText(s, x, y);
}

function drawSection(title, x, y) {
  drawText(title, x, y, C.accent, 14, true);
  return y + 10;
}

function drawMemories(state, y) {
  y = drawSection(`内存 Memory（模式：${state.mode === 'multi' ? '多内存' : '单内存降级'}）`, 20, y);
  const blockW = (cv.width - 60) / 2;
  state.mems.forEach((m, i) => {
    const x = 20 + i * (blockW + 20);
    const top = y + 8;
    ctx.fillStyle = C.panel;
    ctx.strokeStyle = C.border;
    ctx.beginPath(); ctx.roundRect(x, top, blockW, 190, 6); ctx.fill(); ctx.stroke();

    const shared = m.sharedWith ? `（与 ${m.sharedWith} 同一内存）` : '';
    drawText(`${m.name}  ${m.pages}/${m.maxPages} 页  ${(m.bytes / 1024).toFixed(0)} KiB ${shared}`, x + 12, top + 20, C.text, 12, true);

    // 页用量条
    const barX = x + 12, barY = top + 30, barW = blockW - 24, barH = 12;
    ctx.fillStyle = C.cell0; ctx.fillRect(barX, barY, barW, barH);
    const ratio = Math.min(1, m.pages / m.maxPages);
    ctx.fillStyle = ratio >= 1 ? C.warn : C.ok;
    ctx.fillRect(barX, barY, barW * ratio, barH);
    ctx.strokeStyle = C.border; ctx.strokeRect(barX, barY, barW, barH);

    // 字节热力图：前 256 字节，16×16
    const bytes = new Uint8Array(m.sample);
    const cell = 12, gx = x + 12, gy = top + 52;
    for (let r = 0; r < 16; r++) {
      for (let c = 0; c < 16; c++) {
        const v = bytes[r * 16 + c] || 0;
        ctx.fillStyle = v === 0 ? C.cell0 : `hsl(${210 - (v / 255) * 180}, 80%, ${25 + (v / 255) * 40}%)`;
        ctx.fillRect(gx + c * cell, gy + r * cell, cell - 1, cell - 1);
      }
    }
    drawText(`前 ${bytes.length} 字节（0x0000–0x${(bytes.length - 1).toString(16).padStart(4, '0')}）`, gx, gy + 16 * cell + 14, C.dim, 10);
    // 右侧十六进制预览（前两行）
    for (let r = 0; r < 2; r++) {
      const hex = [...bytes.slice(r * 16, r * 16 + 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      drawText(hex, gx + 16 * cell + 14, gy + 12 + r * 16, C.dim, 10);
    }
  });
  return y + 8 + 190;
}

function drawTables(state, y) {
  y = drawSection('表 Table', 20, y);
  const blockW = (cv.width - 80) / 3;
  state.tables.forEach((t, i) => {
    const x = 20 + i * (blockW + 20);
    const top = y + 8;
    const h = 120;
    ctx.fillStyle = C.panel;
    ctx.strokeStyle = C.border;
    ctx.beginPath(); ctx.roundRect(x, top, blockW, h, 6); ctx.fill(); ctx.stroke();

    const shared = t.sharedWith ? `（与 ${t.sharedWith} 同一表）` : '';
    const typeName = t.name === 't2' ? 'externref' : 'funcref';
    drawText(`${t.name}  ${typeName}  ${t.size}/${t.maxSize} 项 ${shared}`, x + 12, top + 20, C.text, 12, true);

    // 槽位
    const box = 34, gap = 6, perRow = Math.max(1, Math.floor((blockW - 24 + gap) / (box + gap)));
    for (let s = 0; s < t.maxSize; s++) {
      const sx = x + 12 + (s % perRow) * (box + gap);
      const sy = top + 32 + Math.floor(s / perRow) * (box + 18);
      const entry = t.entries[s];
      const inRange = s < t.size;
      ctx.fillStyle = !inRange ? '#0d1117' : entry && entry.label ? '#1f6feb33' : C.cell0;
      ctx.strokeStyle = !inRange ? '#21262d' : entry && entry.label ? C.accent : C.border;
      ctx.beginPath(); ctx.roundRect(sx, sy, box, box, 4); ctx.fill(); ctx.stroke();
      drawText(String(s), sx + 3, sy + 11, C.dim, 9);
      if (inRange && entry && entry.label) drawText(entry.label.slice(0, 5), sx + 3, sy + 26, C.accent, 9, true);
      else if (inRange) drawText('null', sx + 5, sy + 26, C.dim, 9);
    }
  });
  return y + 8 + 120;
}

// 初始空画面 + 自动初始化
render(null);
worker.postMessage({ type: 'init' });
