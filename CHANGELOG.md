# Changelog

本项目的所有重要变更记录于此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 简版，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- **win32 overlay 不再抢前台焦点（NOACTIVATE + 键盘面动态放行）**：overlay 窗此前从未设
  `focusable:false`（120 实测确认：点击桌宠即抢走前台焦点，打断用户正在输入的场景；
  全史 59 commit 均如此）。现 win32 下以 `focusable:false` 创建（隐含 `skipTaskbar:true`，
  本就 skipTaskbar，无损失），并在打开含输入控件的面板（聊天 / 设置 / 台词编辑）时经
  `l2d-overlay-focusable` 临时 `setFocusable(true)` + `focus()`，关闭即收回。按面板来源
  OR 汇总——三面板彼此独立、可同时打开，单布尔会在关一个面板时误撤另一个的焦点；
  导航/重载时清空来源表兜底，防来源表残留导致焦点永久放行。linux/darwin 零行为变化
  （d.ts 载明 Linux 的 `focusable:false` 语义是「停止与 wm 交互、所有工作区恒置顶」，
  与 win32 的 NOACTIVATE 不是一回事）。
- **托盘唤出与 second-instance 改用 `showInactive`（win32）**：standalone 托盘「显示桌宠」、
  托盘单击、两形态 `second-instance` 唤出不再抢前台焦点。证实门路径的 `show()` 不动
  （那里有「先 map 才能做命中读回」的语义）；linux 保持 `show()`。

### Docs

- README「游戏中心」更正「不抢前台焦点」旧表述：卫星窗自 7becb95 起为 `focusable:true`，
  点击会正常取得前台焦点（下拉/输入原生可用所必需）；overlay 经本次 win32 修复后不抢。
- `public/game-card.html` 的 NOACTIVATE 注释更正为历史描述（卫星窗已非 NOACTIVATE，
  闪烁病结论与焦点无关）。
- `public/src/interact.js` 与 `docs/fix-2026-09-12-linux-passthrough.md` 的「穿透窗永不聚焦」
  归因更正为「穿透态收不到输入/焦点事件」——行为不变，只修归因。

### Known issues / 待实测

- 运行期 `setFocusable` 切换在分数 DPI 下曾是框架扰动源（卫星窗时代因此冻结运行期切换，
  见 README「卫星窗：分数 DPI 尺寸稳定化」）。overlay 全屏固定尺寸、`resizable:false`、
  永不 resize，风险面不同，但**是否仍会触发框架度量对账自激须在 120 实机确认**。

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
- **desync 看门狗宽限按平台分治（120 Windows 实测修复）**：正向核验要求「交互态下
  光标移动后 `inputGraceMs` 内渲染层须有输入证据」，但输入证据的唯一通道是渲染层心跳
  （`public/src/interact.js` 的 `setInterval(heartbeat, 2000)`）——700ms 宽限 < 2000ms
  心跳周期，属**结构性误报**（宽限内根本等不到下一拍心跳）。Windows 上 `forceReapply`
  是直写（无反向脉冲可愈合），`syncFails` 却照常累加 → 3 次进安全态恒穿透 60s/120s
  退避，桌宠点不动（120 实测复现两轮）。现将非 Linux 平台宽限抬到 2500ms
  （> 心跳周期 + 余量），Linux 保持 700ms 不变（Linux 有 X 层命中读回作独立第二通道，
  且 toggle-through 真能愈合，收紧有利及早捕获真失同步）。⚠️ 心跳周期若未来改动，
  必须同步复核该常量。
- **minimize 守卫注释更正（实测修正注释，非行为变更）**：旧注释断言「Windows 无框窗
  不触发 minimize 事件」，2026-09-24 Win11 25H2 实测证伪——Win+D / 显示桌面会触发
  无框透明窗的 `minimize` 事件（连续两次 Win+D 触发两次），靠 `win.restore()` 守卫
  正常救场；同次实测显式 `SC_MINIMIZE` / `SW_MINIMIZE` 路径不触发。守卫代码本身未改动，
  仅注释改为如实描述，并明确该守卫跨平台**必需**。

### Changed

- `index.js` 的 `source.kind` 对齐 `plugin:NAME` 协议格式
  （`'plugin'` + 独立 `plugin` 字段 → 单一 `'plugin:dsh-live2d-companion'`）。

### Known issues / 待实测

- Windows 实机验证尚未执行（排在 120 测试项之后），本版 win32 分支改动均未经真实 Windows 桌面确认。
- win32 下 desync 愈合写为同值写，是否会被 Electron 去重吞掉存疑——若被吞，
  该路径的失同步愈合在 Windows 上可能失效（Linux 侧由 toggle-through 规避，不受影响）。
  2026-09-24 120 实测补充：该直写确为空转；其直接后果（desync 累加进安全态）已由本版
  宽限分治消解误报源，但「同值写是否被去重吞掉」本身仍未定论。
- **点击桌宠会抢前台焦点**：未设 `WS_EX_NOACTIVATE`，点桌宠后原前台窗口失焦，可能打断
  用户正在输入的场景。是否加该扩展样式（代价：桌宠不再接受键盘输入/无法聚焦）待主人裁决。
- **workArea 变化后存在 ~560ms 越界瞬态**：`display-metrics-changed` 的 500ms 去抖期内
  窗口仍按旧工作区摆放，任务栏位置/分辨率切换的瞬间桌宠可能短暂越界（约 560ms 后归位）。
  去抖本身是为规避瞬态误判 FULLSCREEN 的既定取舍，此处仅记录现象，非缺陷。
- **托盘图标默认落入 Win11 溢出区**：Windows 11 默认隐藏新注册的托盘图标，需用户在
  「任务栏设置 → 其他系统托盘图标」里手动固定。系统行为，非本项目缺陷。

## [1.1.0] - 2026-09-13

Linux/X11 穿透硬化与跨平台移植；游戏中心与 standalone 独立运行时。

## [1.0.0] - 2026-08-16

Initial release.
