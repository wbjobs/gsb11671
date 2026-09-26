# WebAssembly 多内存 × 多表演示

在单个 wasm 实例中同时使用 **2 个内存** 和 **3 个表**，演示内存间拷贝、跨表函数引用、
内存/表增长，并用 Canvas 实时可视化内存与表状态。所有 wasm 计算都在 **Web Worker**
中执行，主线程只负责渲染，保证 UI 不卡。

## 运行

```bash
# 任选其一启动静态服务器（Worker 不能用 file:// 加载）
python3 -m http.server 8000
# 或 npx serve .
```

浏览器打开 http://localhost:8000

## 功能与验收标准对照

| 验收标准 | 实现 |
| --- | --- |
| 多内存多表可用时操作正确 | `memory.copy` 跨内存拷贝（mem0↔mem1）、`table.copy` 跨表复制、`call_indirect` 指定表下标 |
| 内存/表增长正确 | `memory.grow` / `table.grow`（填充 `ref.func`），超 max 返回 -1 并提示 |
| 越界被捕获 | 越界读/写触发 `RuntimeError: memory access out of bounds`；表越界 `RangeError` |
| 引用类型不匹配有提示 | `call_indirect` 签名不匹配 trap；funcref 表 `set` 普通对象抛 `TypeError`，externref 表接受 |
| 不支持时降级 | 特性检测失败自动切换到单内存单表模块（导出名兼容），UI 禁用多内存专属按钮 |
| 实例化失败有提示 | 缺失 import → `LinkError`；损坏字节 → `CompileError`，均捕获并展示 |
| 状态可视化准确 | Canvas 绘制内存页块 + 前 512 字节热力图（TypedArray 采样）、表槽位与函数名 |
| 主线程不卡 | 全部计算在 Worker；压力测试按钮 + 实时 FPS 计数器验证 |

## 技术栈

WebAssembly（手写二进制编码，见 `wasm/build-wasm.mjs`）+ Web Worker + TypedArray + Canvas

## 文件结构

```
index.html            页面
css/style.css         样式
js/main.js            主线程：UI、Canvas 渲染、FPS
js/worker.js          Worker：实例化、特性检测、降级、全部操作
js/wasm-bytes.js      生成的 wasm base64（请勿手改）
wasm/build-wasm.mjs   wasm 二进制编码器（multi / single / bad 三个模块）
wasm/test-node.mjs    wasm 模块行为测试（27 项）
wasm/test-worker.mjs  Worker 逻辑冒烟测试（33 项）
wasm/test-fallback.mjs 降级路径测试（10 项）
```

## 测试

```bash
node wasm/build-wasm.mjs   # 重新生成 wasm
node wasm/test-node.mjs
node wasm/test-worker.mjs
node wasm/test-fallback.mjs
```
