# WebAssembly 多内存 × 多表 演示

在**单个 wasm 实例**中同时使用多个内存和多个表，覆盖：内存间拷贝、跨表函数引用、
内存/表增长（含失败）、越界捕获、引用类型不匹配、实例化失败、不支持时降级单内存单表。

## 运行

```bash
cd 本目录
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

> 必须通过 HTTP 访问（Web Worker 不能用 file:// 加载）。
> multi-memory 需要 Chrome 119+ / Edge 119+；不支持的浏览器会自动降级并提示。

## 自检（无需浏览器）

```bash
node test-node.js   # 在 Node 中验证全部 wasm 模块行为（28 项断言）
```

## 文件

| 文件 | 说明 |
| --- | --- |
| `wasm-enc.js` | 极简 wasm 二进制编码器（LEB128 / 各 section / 多内存 memarg），无第三方依赖 |
| `modules.js` | 构造 5 种模块：多内存多表、降级单内存单表、缺导入、start 陷阱、编译期类型不匹配 |
| `worker.js` | Web Worker：特性检测、实例化、全部演示动作、状态采集（TypedArray + transferable） |
| `main.js` | 主线程：按钮、日志、FPS 监控、Canvas 状态可视化 |
| `index.html` / `style.css` | 页面与样式 |
| `test-node.js` | Node 自检测试 |

## 演示内容对照

- **多内存**：`memA`(max 4 页) / `memB`(max 2 页)，`memory.copy $dst $src` 双向拷贝、`memory.fill`、按内存索引的 `memory.size/grow`
- **多表**：`t0`/`t1` funcref + `t2` externref；`call_indirect` 指定表索引、`table.copy`、`table.get/set` 跨表移动函数引用
- **跨表调用链**：`callT1 → t1[dispatch] → call_indirect t0[add/mul](7,6)`
- **增长**：`memory.grow` / `table.grow` 返回旧大小，到达上限返回 -1（增长失败提示）
- **越界**：越界 `i32.load8_u` 与越界 `call_indirect` 均触发 RuntimeError 并被捕获
- **引用类型不匹配**：编译期（funcref 写入 externref 表 → CompileError）、运行时（签名不匹配 → trap）、JS API（`Table.set` 类型检查 → TypeError）
- **实例化失败**：缺少导入（LinkError/TypeError）、start 函数陷阱（RuntimeError）
- **降级**：`WebAssembly.validate` 检测 multi-memory，不支持时实例化单内存单表模块（同名导出，UI 无感）
- **主线程不卡**：所有 wasm 操作在 Worker；压力测试期间观察主线程 FPS
