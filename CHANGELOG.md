# Changelog

本项目的所有重要变更记录于此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 简版，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-09-24

覆盖自 454073b 以来的变化（53b71a3 / 73f3b84 / 42fc029）。

### Added

- 根 `package.json` 新增 `npm test` 聚合脚本，一条命令串起全仓测试套件
  （chess engine/ai、gomoku engine/ai、llm-duel、pet-lifecycle 与
  `pet/passthrough-verify.mjs`），共 96 + 63 断言。

### Fixed

- **pet 覆盖窗原点与尺寸统一为 workArea**：此前按 `display.bounds` 铺满整屏，
  任务栏在左/上时覆盖窗被任务栏遮挡或错位；改用 `display.workArea`。
  同时为 `display-metrics-changed` 加 500ms 去抖——事件到达瞬间 WM 转场尚未完成，
  读到的仍是旧尺寸，按旧值 `setBounds` 会让无框透明窗在瞬态里被误判 FULLSCREEN，
  Cinnamon 随之藏掉面板；定时器内重新取当下的 display 对象与工作区，绝不复用闭包旧值。
  另加全屏自摘防御：WM 若仍把本窗标成全屏，立刻 `setFullScreen(false)`。
  standalone 运行形态同步该治疗。
- **Windows 穿透证实门改为能力探测分流**：Electron 43.4.0 的 `BrowserWindow`
  只有 `setIgnoreMouseEvents`（只写），**没有 `isIgnoreMouseEvents()` 读回 API**，
  无条件调用即每拍 TypeError → 永不证实 → `show` 被推迟且凭据永远拿不到
  `passthroughProvenAt` → 宿主带病重生保护反被假阳性触发。现先做能力探测：
  探测为假（43.4.0 实况）走**乐观直通**，立即登记证实并 `show`，标签如实标注
  `no-readback-api optimistic`，不谎称读过；探测为真（未来 Electron 补上读回 API）
  启用**真读回门**——盲写后 ~100ms 一拍轮询，连续 2 拍读到 `true` 才登记证实，
  3s 超时未证实则如实上报 + 凭据记 `unproven` + 降级 `show`。
- **toggle-through 反向脉冲仅限 Linux**：Linux/X11 下同值盲写会被 Electron 内部去重吞掉，
  且 X11 input-shape 异步生效，反向脉冲是强制 XShape 真实重发的唯一手段；
  但 Windows 无此病灶，反向脉冲只会在真实窗口上放行 300ms 鼠标。现 win32/darwin 走直写，
  消除该 300ms 反向穿透窗。
- **standalone 托盘图标 SVG → PNG**：Windows 托盘对 `data:image/svg+xml` 支持不稳，
  `nativeImage` 在部分 Electron/Windows 组合下解出空图，托盘图标整块空白；
  改为 `createFromPath('tray-icon.png')`（`nativeImage` 官方仅支持 PNG/JPEG）。
  图标由 `standalone/make-tray-icon.mjs` 用 node 内置 zlib 生成，无任何 npm 依赖。

### Changed

- `index.js` 的 `source.kind` 对齐 `plugin:NAME` 协议格式
  （`'plugin'` + 独立 `plugin` 字段 → 单一 `'plugin:dsh-live2d-companion'`）。

### Known issues / 待实测

- Windows 实机验证尚未执行（排在 120 测试项之后），本版 win32 分支改动均未经真实 Windows 桌面确认。
- win32 下 desync 愈合写为同值写，是否会被 Electron 去重吞掉存疑——若被吞，
  该路径的失同步愈合在 Windows 上可能失效（Linux 侧由 toggle-through 规避，不受影响）。

## [1.1.0] - 2026-09-13

Linux/X11 穿透硬化与跨平台移植；游戏中心与 standalone 独立运行时。

## [1.0.0] - 2026-08-16

Initial release.
