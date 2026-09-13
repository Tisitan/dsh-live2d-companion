# 修复落地报告（2026-09-12）

基线：HEAD + 工作树未提交批（index.js 两处 process.platform 跨平台分支 + pet/restart-dsh-web.sh + quips.json）之上实施，既有未提交改动全部保留。未 git commit；遵循既有代码风格。

## 议题：Linux/X11 桌宠鼠标穿透状态机卡死（双向：穿透后不能恢复交互 / 交互后面板永不消失）

**根因结构**（昨夜只读侦察结论 + 本次修复中真机复核）：
- 运行期唯一穿透开关 `setIgnoreMouseEvents` 是盲写（Electron 无读回 API），X11 input-shape 与主进程认知偶发失同步；
- 旧判定状态机跑在渲染层、靠 DOM 事件驱动——穿透态下事件物理上不进窗口，状态机一旦与实际不符即永久卡死、无自愈通道；
- 面板/台词卡/帮助卡的「×/外点/Esc」三路关闭全走 DOM 事件，穿透态三路失联；
- Linux WM 可把全屏 overlay 窗最小化且 skipTaskbar 无入口找回。

## 批次1：主进程单源决策（根治）

- **`pet/passthrough.cjs`（新增）**：决策状态机共享模块（CJS）。输入=渲染层上报的交互矩形集（模型包围盒+48px ∪ 可命中 UI 矩形 ∪ pinned/dragging 标志）+ 宿主推送的卫星窗死区 + OS 光标坐标；输出=每 tick 驱动 `setIgnoreMouseEvents`。语义与旧渲染层状态机逐条等价：卫星窗死区恒穿透 > UI 即时可点 > pinned 恒穿透 > 模型区停留 600ms（位移≤24px）放行 / 出框滞回回收。状态迁移经 `l2d-interact-state` 回推渲染层（锁钮三态 + dwellDebug 探针数据源）。
- **`pet/main.js` / `standalone/main.cjs`**：接入共享决策器（33ms 轮询 tick 先于光标推送——停留到期判定不依赖光标移动）；新增 `l2d-rects`/`l2d-heartbeat` IPC 与 `l2d-renderer-error` 取证转发；`l2d-ignore` 通道保留为应急逃生门；`pushCardArea` 同步死区进决策器。两形态共用同模块保证行为一致。
- **`public/src/interact.js`**：evalIgnore 重写为「矩形集维护 + 变化上报」（差分节流，无变化零 IPC）；uiHit 与上报共用 `UI_SELECTOR` 常量；`hitTestable()`（visibility/display/pointer-events 三过滤）保证隐藏按钮/收起卡片不占解锁区，等价旧 `elementFromPoint` 语义；渲染层不再直接 `setIgnore`。新增 150ms 矩形集保鲜轮询——覆盖呼吸动画/切换动画/扩展操纵等无事件路径的模型位移（真机实验发现的事件驱动盲区，事件只在交互态可达，穿透态下的保鲜必须主动轮询）。
- **`public/src/chat.js`**：`protect()` 的 pointerenter 与 `openChat()` 两处 `BRIDGE.setIgnore(false)` 旁路收编为 `ctx.evalIgnore()`——聊天控件矩形本就在上报集内，旁路盲写会与决策器打架。
- **`public/src/stage.js`**：ResizeObserver 回调补 `evalIgnore`（布局变化连动矩形集重报）；缩放动画 ticker 原有调用点经重写后的 evalIgnore 自动转化为矩形上报。
- **批次6（dwell 语义 + ticker 挂钩）**：600ms/24px 常量迁入主进程同值实现；矩形集上报挂在 ticker 缩放动画与 150ms 保鲜轮询双通道。

## 批次2：三重看门狗

- **a) 行为核验**（`passthrough.cjs` tick 尾段）：正向——交互态下光标移动后 700ms 内渲染层须有真实输入到达（心跳上报 `lastInputAt`），缺失即重申施加；穿透态下渲染层仍持续收到「施加 400ms 之后才产生」的新鲜输入且光标在空白区，反向重申施加（在途余波不算，防 X11 shape 异步生效期的误报——真机首轮即抓到并修正）。输入证据到达即核销+计数清零。
- **b) dragging 悬挂**（`interact.js`）：pointerdown/move 刷新 `draggingAt`，>30s 静默由 5s 周期看门狗强制 `endDrag` 并补判穿透（穿透窗永不聚焦收不到 blur，此为 blur 兜底失效后的最后保险）；触发经 `reportError` 转主进程日志留痕（渲染层 console 不进宿主日志——本轮真机排障实证的观察盲点）。
- **c) 失同步安全态**：连续 3 次核验失败 → 恒穿透 60s（防全屏捕获输入），到期自动重试恢复，再失步重进。

## 批次3：面板连带收拢（`public/src/panel.js`）

`scheduleHide` 去掉 panelOpen/helpOpen/quipsOpen 阻断，超时回调收拢菜单 + `closePanel()` + `toggleQuips(false)` + `toggleHelp(false)` 再隐按钮——穿透态下三卡失联的关闭通道由超时收拢兜底。安全性：`hideChrome` 只在光标离开模型邻近区+UI 区时触发（onCursor 的 nowInside 迁移沿），收拢瞬间光标必然不在卡片上，不打断正在操作的人。

## 批次4：minimize-guard（`pet/main.js` + `standalone/main.cjs`）

`win.on('minimize')` → 立即 `win.restore()` + console.error 取证。Windows 无框窗不触发该事件，跨平台无害。

## 批次5：收尾补判

stage.js ResizeObserver（见批次1）；interact.js PET 分支 `endDrag` 与 blur 兜底末尾补 `ctx.evalIgnore()`（拖拽冻结解除后矩形集含 dragging 标志立即上报）；挂件分支 endDrag 同补（盒子位移后模型矩形保鲜）。

## 验证

语法：`node --check` 全部改动文件通过（pet/passthrough.cjs、pet/main.js、pet/preload.js、standalone/main.cjs、standalone/preload.cjs、public/src/interact.js、panel.js、stage.js、chat.js、boot.js、package.json）。

测试全绿：
| 测试 | 结果 |
|---|---|
| `node --test pet-lifecycle.test.mjs` | 20 通过 / 0 失败 |
| `node --test games/gomoku/engine.test.mjs` | pass |
| `node --test games/chess/engine.test.mjs` | pass |
| `node --test games/chess/ai.test.mjs` | pass |
| 决策状态机离线验证（临时脚本 /tmp/passthrough-verify.mjs，10 组用例） | 21 通过 / 0 失败（空集恒穿透 / 停留放行 / 出框回收 / 位移重置 / UI 即时 / pinned / 死区优先 / 拖拽冻结 / 正反向核验 / 安全态 / 脏数据剔除） |

### 真机验证（Linux/X11，DISPLAY=:0，1920x1080，独立 HOME 单实例锁不扰生产；本机用户实时操作构成强干扰源，已用模型追光标+合成事件等抗干扰手段绕开）

| 项 | 方法 | 结果 |
|---|---|---|
| 穿透→交互（dwell 放行） | CDP 平移模型到 OS 光标下（等价拖拽的矩形变化），采样 | t=300/600ms false → **t=900ms true**；主进程日志 `passthrough -> interactive @698,927` |
| 交互→穿透（滞回回收） | 模型移回原位 | `passthrough @698,927` 立即回收 |
| 点击穿透取证 | 穿透态 xdotool click，渲染层 capture 计数器 | 两轮 **clicks=0**（点击穿透到下层） |
| 交互态点击到达 | 交互态 xdotool click | **clicks=1、2** |
| pinned 三态 | 真机实测（用户实际点击锁钮）| 决策器随 pinned 翻转：锁定时模型区恒穿透、锁钮本身保持可点 |
| 正向核验自愈 | 交互态下小幅度移动光标制造无证据窗口 | `desync #1: interactive but no input reached renderer -> reapply` 真机触发 |
| dragging 悬挂看门狗 | 合成 pointerdown 置位 + 30s 静置 | 32s 内渲染层触发 `force endDrag`，经 reportError 在主进程日志留痕（含悬挂起始时间戳） |
| minimize-guard | `xdotool windowminimize` | 日志 `minimized by WM, restoring`，3s 后窗口 IsViewable（启动期 WM 5 次 iconic 亦全部弹回） |
| 生产实例 | 宿主 M3 看门狗重拉 | 重拉实例携新代码运行，窗口在位 |

### 遗留

- 行为核验的理论边界：穿透态若 shape 失效且光标完全静止（无事件可作证据），反向核验无法发现，需等待下一次鼠标移动——Electron 无读回 API 下的探测论极限，安全态兜底不受影响。
- 决策器 60s 安全态到期自动重试期间的翻转在 L2D_DEBUG=0 下不可见（只留 desync/safe mode 的 console.error），如需常态审计可另行落盘。
- `l2d-ignore` 应急通道现为无消费者的保留接口（渲染层已无调用方），如确认无外部使用可在后续版本与 standalone/preload.cjs 的同名接口一并移除。

---

# 第二轮：生产环境复测驳回的排查与修复（同日追加）

**驳回症状**：用户在生产实例实测——穿透态下真鼠标悬停桌宠，配置按钮簇不出现，交互态进不去。独立测试实例验证通过，生产失败。

## 第一步：生产实例代码版本结论

- 生产实例（凭据 ~/.dsh/live2d-companion/pet.pid 指向）启动于 12:49:37，晚于修复全部落盘（~12:41）——**代码版本排除**，跑的是完整修复版（新代码仍败，进入现场诊断）。
- 过程中发现该实例为 detached spawn（reparent 到 systemd --user 属正常，宿主 spawn 用 detached+unref），凭据确认宿主管理关系成立。
- 附带取证发现：生产 userData 的 `l2d-pet-pinned = 1` 残留——锁定态（用户曾点击锁钮）下模型区恒穿透是**设计语义**，这是悬停不进交互态的因素之一（已复位并向用户说明锁钮语义）。

## 第二步：现场诊断——真正的根因

带 `L2D_DEBUG=1` + 生产 userData 起诊断实例（凭据写回原路径，宿主探活可收养），逐环取证：

| 环节 | 结果 |
|---|---|
| boot/模型/BRIDGE 接口 | ✓ 正常，无 console 异常 |
| pinned 残留 | 发现 true（已复位），复位后症状仍在 |
| l2d-rects 上报链 | ✓ 决策器 rects.model 与渲染层 bounds 精确一致（差 = 48px margin） |
| l2d-cursor 推送链 | **✗ 断**——渲染层 lastPointer 停滞，按钮簇永不出 |
| 主进程 33ms 轮询 | ✓ interval 活着（poll diag 周期输出） |

**真根因（X 侧 vs 进程侧对比定位）**：`screen.getCursorScreenPoint()` 读数**进程内冻结**（恒返回旧值如 (666,613)/(939,809)），而 `xdotool getmouselocation`（直读 X 服务器）正常跟随。

机理：Electron Linux/X11 的光标读数来自 **Chromium 自身事件流缓存**——窗口穿透（input shape 全空）期间 X11 不派发任何指针事件给该窗口 → 缓存停更 → 读数滞后/冻结（间歇性，用户高速划动鼠标后尤甚）。冻结的连锁：`moved` 恒 false → `l2d-cursor` 永不推送 → 按钮簇（nowInside 迁移沿）永不出现；决策器比对假坐标 → dwell 永不启动 → 交互态进不去。**这正是「昨晚侦察的双向卡死」的真凶本体**，与 input-shape 失同步是叠加的两层问题。

## 修复（第二批）

1. **混合光标源**（`pet/main.js` / `standalone/main.cjs` / `passthrough.cjs`）：Linux/X11 下每 500ms 经 `xdotool getmouselocation --shell` 采集独立光标（直读 X 服务器，不受穿透影响），喂给决策器；决策 tick 光标源仲裁——外部探针新鲜（<3s）优先采用，否则回退主读数。连续 3 次探针失败（xdotool 缺失）自动停表回退。Windows 无此问题且无 xdotool，整段 `platform !== 'win32'` 守卫，零影响。
2. **冻结自愈探针**（`passthrough.cjs`）：决策光标静止 60s（穿透态）→ 触发宿主 `wiggle()` 钩子——窗口 1px 微移往返（X11 Configure 事件实证可强制 Chromium 重同步光标缓存；1px 视觉无感、无解锁窗口、不碰穿透语义）。
3. **desync 重试改 toggle-through + 静默期重置**：先反向 300ms（X11 shape 复位窗，覆盖在途事件余波排空）再回目标值，破同值重申被内部去重吞掉的问题；retryEpoch 代数防过期重放污染；重申时重置 passAppliedAt 静默期防连锁误判（第一版 50ms 窗在冻结+高速划动场景曾三连误判进安全态，已修正）。

## 第二轮验证

- 决策器离线验证扩至 **25/25**（新增：wiggle 探针触发/不改 interState/解冻后放行/无解锁窗误报）。
- 生产等同环境（同 userData）诊断实例：`extCursor` 探针活（age≈250ms）；**真鼠标悬停模型 → 按钮簇 visible（t+400ms 即出现）→ 1.0s 交互态进入**（此前生产症状的核心链路全通）。
- 主读数滞后场景：xdotool 源接管后决策持续可用（500ms 粒度降级，dwell 实测 1s 内放行）。
- 全量回归：pet-lifecycle 20/20 + games 3 项全绿；node --check 全过。
- 生产实例已以正常模式（无 DEBUG）补位运行，凭据指向正确，9222 未泄漏。

### 第二轮遗留

- 光标读数冻结的「间歇性」机理（Chromium 事件流缓存的更新时机）未完全定界，以 500ms xdotool 交叉源 + 60s wiggle 自愈双保险兜住功能；若未来 Chromium 修复缓存策略可移除探针。
- xdotool 为运行期软依赖：缺失时自动停表回退主读数（功能退化为第一轮状态，不再卡死——单源决策与看门狗仍在）。
- 生产 userData 曾处于锁定态（pinned=1）已复位；若用户有意锁定请再点锁钮（蓝圈=彻底不响应，属正常语义）。

---

# 第三轮：用户体感「修了和没修一样」的排查与修复（同日 14:30 收口）

**症状**：生产实例悬停仍不出配置栏；「上了🔒就触发不了鼠标放上面的配置栏」（锁死即无解）。

## 取证链（先证版本与状态，再谈症状）

| 取证项 | 方法 | 结论 |
|---|---|---|
| 生产代码版本 | pet.pid 凭据 bornAt=13:32:00 vs 二轮修复落盘 13:28:45 | 进程晚于落盘，**跑的是最新代码**，排除「凭据收养旧进程」假象 |
| xdotool 探针在位 | `sudo strace -f -e execve -p <main pid>`（ps 采样会漏——探针进程寿命仅 ~15ms） | **探针正常运行**，500ms 周期 execve 全部 exit 0 |
| pinned 状态 | leveldb 000003.log 时序扫描 `l2d-pet-pinned` | **终值=1（锁定中）**——二轮复位后用户测试时再次锁定 |
| 基线行为 | XQueryPointer 命中测试（python-xlib `root.query_pointer().child`） | 光标置模型中心 2s，child=下层窗口≠pet → 锁定态恒穿透，符合设计但用户无感知 |
| 基线截图 | gnome-screenshot | **锁钮不可见**——pinned=1 但屏幕上没有任何锁定标识/解锁入口 |

## 真因定位（两个独立缺陷叠加）

**真因 A：l2d-cursor 推送链仍绑死在被冻结的 Chromium 主读数上。**
二轮把 xdotool 交叉源只接进了决策器（`passthrough.externalCursor`），而 33ms 轮询里的
`l2d-cursor` 渲染层推送（按钮簇 nowInside 迁移沿、视线跟随的数据源）依旧只用
`screen.getCursorScreenPoint()`（pet/main.js 旧 399-408 行）。主读数冻结时：决策器能靠
外部源进出交互态，但推送断流 → 渲染层 `wasInside/nowInside` 迁移沿永不触发 →
**按钮簇永不出现，用户体感「和没修一样」**。第二轮诊断实例验证时主读数恰好没冻结
（间歇性），漏过了这条链——「独立实例通过≠生产通过」的第二次学费。

**真因 B：批次3「面板连带收拢」引入的回归——`scheduleHide` 无条件隐藏锁钮。**
panel.js `scheduleHide` 超时回调对四个按钮一律 `add('l2d-hidden')`（含 pinToggle），
直接违背点击处理器里「锁定时必须现身——它是不响应的常驻告示」的设计意图。
pinned=1 下模型区恒穿透（设计语义）+ 锁钮被隐 → **屏幕上不存在任何解锁热区**，
重启后锁定态经 localStorage 持久化依然无解 → UX 死锁，即用户报的「上了🔒就触发不了」。

## 修复（第三批）

1. **推送链接入仲裁源**（`pet/passthrough.cjs` / `pet/main.js` / `standalone/main.cjs`）：
   决策器 `tick()` 返回当次仲裁后的决策光标并新增 `cursor()` 访问器；主进程轮询改为
   「主读数动则推主读数（33ms 顺滑）；主读数静止则推仲裁源（xdotool 接管不断流）」。
   首帧拉取 `l2d-cursor-get` 同步改用仲裁值。Windows/macOS 无外部探针，仲裁回退主读数，
   行为与改前逐字节等价，零回归。
2. **锁定态锁钮常驻**（`public/src/panel.js` scheduleHide）：`ctx.pinned` 时跳过对
   pinToggle 的隐藏——蓝圈呼吸锁钮即「不响应」视觉告示 + 常驻解锁热区。悬停锁钮 →
   UI 矩形即时可点（决策优先级：UI > pinned）→ 点击解锁。锁定语义本身不变
   （模型区依旧恒穿透）。
3. **探针平台守卫收紧**：`!== 'win32'` → `=== 'linux'`（macOS 无 xdotool 也无此病理，
   原写法会空转 3 次失败再停表）。Windows 路径不受影响。

## 第三轮验证

- 决策器离线验证扩至 **32/32**（新增：tick 回传仲裁光标 ×3 / 探针过期回退 / 拖拽早退
  回传 / 外部源接管下 dwell 放行——主读数冻结不挡路）。
- 全量回归：pet-lifecycle 20/20、gomoku 27、chess engine 24、chess ai 8、llm-duel 17，
  node --check 全部改动文件通过。
- 真机验收（生产实例实跑，DISPLAY=:0，XQueryPointer 命中测试 + 截图双通道取证）：

| 验收项 | 结果 |
|---|---|
| 锁定态锁钮常驻（pinned=1 重启后） | ✓ 蓝圈锁钮现身模型右上方 |
| 锁定态悬停锁钮 → 可点 | ✓ over_pet=True（child=0x03a00004） |
| 点击锁钮解锁 | ✓ 气泡「解锁：恢复自动」，pinned 落盘 0 |
| 移开 → 恢复穿透 | ✓ over_pet=False |
| 悬停模型 → 按钮簇出现 → 进交互 | ✓ over_pet=True + 截图按钮簇可见 |
| 悬停期 input-shape 失同步 | ✓ 行为核验 1 次捕获（desync #1）→ toggle-through 自愈，无安全态 |
| 点 ⚙ → 菜单 → 「切换模型」→ 面板 | ✓ 模型面板完整打开（截图取证） |
| 移开 → 面板连带收拢 + 穿透恢复 | ✓ over_pet=False，按钮簇隐退 |
| 生产实例正常模式收官 | ✓ pid 178028 bornAt 14:29:25，单窗，9222 未开，宿主收养无重复 spawn |

## 第三轮遗留

- 探针 500ms 粒度下，主读数冻结期的视线跟随/推送为 2Hz 降级（功能无损，顺滑度降级）；
  主读数活跃时自动回到 33ms 满血。
- 反向核验（穿透态仍收输入）在「用户高速操作 + 探针采样滞后」叠加时存在理论误报窗
  （坐标比对用的是 500ms 前的采样位置），单次 toggle-through 即自愈，不影响使用。
- pinned=1 锁定含义的用户教育成本仍在：锁钮常驻蓝圈是被动提示，用户若想更显性可
  后续加「锁定中」气泡首提示（本轮未做，YAGNI）。
- 本轮三次生产重启均走「杀→手动补位 spawn」路径，宿主 M3 滑窗计数零消耗
  （凭据探活收养，30s 检查全部 skip）。

---

# 第四轮：启动期穿透失效事故（22:51 全屏捕获失控）正式排查 + 规划 + 修复

## 阶段一·排查（全部实证，无假设）

### 时间线重建（journalctl --user + last + ps lstart 三方对照）

- 22:48 **整机重启**（last reboot 实证；uptime 吻合）——非 dsh web 单独重启。
- 22:48:58 aurora-desk 自启（排除嫌疑：与事故无关，仅同窗）。
- 22:49:40 dsh web（pid 3308）自启。
- ~22:50:4x 宿主 spawn 桌宠（scope `app-dsh-live2d-companion-pet-3752`），X 会话/合成器此刻仅 ~2 分钟龄。
- 22:51 事发：桌宠窗口（1919x1040 置顶透明）未进穿透态，全屏捕获输入，用户失控强杀（22:50:59 scope consumed）。
- M3 看门狗 30s 退避重生三次全部带病：5763（22:51:29）/ 6297（22:52:14）/ 6651（22:52:48）。
- 22:54:48 止血：cordis.patch.yml 改 pet:false + pkill（配置端点热生效实证）。

### 取证工具建设与试错（诚实记录，工具本身也证伪了一版）

| 工具 | 结论 |
|---|---|
| `shape_get_rectangles(SK.Input)`（python-xlib Shape 扩展读回） | **对 Electron 无效**——Electron 43 的 ignoreMouseEvents 不落 Shape Input/Bounding 任一层（恒读 1 全窗口矩形），但 ShapeNotify 事件随 toggle 到达、命中测试真实切换。初版守护据此判 INTERACTIVE 造成 10/10「复现」误报，作废并诚实记录 |
| `root.query_pointer().child`（XQueryPointer 命中测试） | **金标准**——随 toggle 真实切换；手动置空 ShapeInput 亦穿透生效。pet 全屏置顶架构红利：光标恒在窗口矩形内，无需移动光标即可随时读回 |
| `xdotool getmouselocation --shell` 的 WINDOW 字段 | 校准证实=命中窗口 id（query_pointer 语义等价物），且主进程 500ms 探针本就在跑此命令——读回零新增成本 |
| ShapeNotify 事件订阅 | 事件级确认 Electron 的 shape 操作到达 X 层（shaped 字段随 toggle 交替），排除「API 会话级无效」误判 |

### 关键实验（mini app 变量分离 + 端到端复现）

1. **mini app（同窗口配置，3s 交替 setIgnoreMouseEvents）**：命中测试跟随切换 → **API 在当前会话有效**，T0 创建即调亦曾生效（前 1.5s 穿透）。
2. **窗口移动重置穿透（实锤）**：穿透期 `xdotool windowmove +1px` → 立即变捕获，直到下次 API 施加才恢复。wiggle（1px 微移）在实证上是「穿透自残」操作。
3. **端到端事故复现（死 URL 实例）**：L2D_URL 指向不可达地址（模拟冷启动 host 未就绪）→ 窗口 map 即捕获，30s 守护观测无自愈。
4. **有效 URL 对照实例**：T0 曾短暂穿透（206ms）→ 导航/渲染器附加后转捕获；dwell 模型记忆位 1.8s **无任何翻转**（日志零 `passthrough ->` 记录）→ 30s 持续捕获。
5. **渲染层缺位链实证**：当前会话 Chromium WebGL 被 blocklist（会话级，生产 userData 同症）→ `new PIXI.Application` 抛错 → boot.js 的 `await initStage(ctx)` 中断 → **initInteract 永不执行** → 矩形集/心跳/输入证据全缺 → 决策器永不翻转、行为核验全盲。

### 事故根因（证实版）——四缺陷叠加，缺一不可成灾

1. **初始穿透是单次盲写且无证实**（pet/main.js:91）：启动窗口期不可靠（实测 206ms 内被导航事件重置），此后决策器稳态不再重申（只在 target≠interState 翻转时 apply）。
2. **窗口移动重置穿透**（X/WM 层语义，Edge 对照同样重置）：wiggle 自愈探针反而成为穿透杀手；触发条件把「光标静止」误当「读数冻结」（无正向证据），正常静止场景每 60s 挨一刀。
3. **渲染层缺位时看门狗全盲**：页面加载失败（host 未就绪退避）或 WebGL 崩（initStage 中断 initInteract）→ 反向核验的证据源（lastInputAt 心跳）恒 0、且其武装条件 passAppliedAt≠0 在冷启动不成立；正向核验要求已进入交互态。三条看门狗无一覆盖「启动即捕获」路径。
4. **宿主带病重生**：M3 看门狗只按滑窗计数，不校验上次死因/健康度，30s 后原样重生 → 同条件复发 → 灾难循环。

**事故剧本还原**：冷启动 → spawn 时 host HTTP 未就绪（dsh web 起来仅 ~70s）+ 会话级 WebGL blocklist → 页面加载失败/渲染层崩 → 初始盲写失守 → 光标静止 60s → wiggle 补刀（若初始穿透曾生效）→ 全屏永久捕获 → 用户失控 → 强杀 → 带病重生 ×3 → 熔断止血。

### 为什么上个会话（00:20-22:47）8 小时无事

渲染层在位 + 用户光标活跃 → 任何捕获态都会被「光标活动引发决策翻转」或反向核验在亚秒级修复（白天日志中的 desync 记录即 wiggle 重置后被核验修复的证据）。两个隐藏前提（渲染层在位、光标活动）在冷启动场景同时崩塌。

## 阶段二·修复规划（fail-closed：穿透未证实前窗口不显示）

### 设计 1：显示门（证实点）

- `show: false` 创建窗口 → 施加初始穿透 → **X 层命中读回证实**（复用 500ms xdotool 探针的 WINDOW 字段：≠ pet 窗口 id 即穿透；窗口 id 用 `win.getNativeWindowHandle()` 自取）→ 连续 2 拍一致证实后 `win.show()`，凭据增写 `passthroughProvenAt`。
- 未证实：保持隐藏 + 重申 apply(true) + 重试（1s×N → 5s 慢速），console.error 告警。**永不因未证实而显示**——窗口隐形即无害，这是「带病重生」悖论的根治（重生最坏结果=桌宠不出现，而不是捕获屏幕）。
- 读回不可判场景（光标在副屏/同级置顶窗上）：不计数、不采信，继续等；运行期校验环兜底。
- 全平台语义：读回优先用 `win.isIgnoreMouseEvents()`（Electron 原生读回，Windows 上内部状态即真实）；Linux 叠加 xdotool 命中实证（探针缺失时退化 Electron 读回 + 日志降级声明）。Windows 行为差异仅限「show 延迟数毫秒」，无语义变化。

### 设计 2：运行期校验环（X 层直接证据，不再依赖渲染层在位）

- 探针每次响应顺带解析 WINDOW → `passthrough.observedHit(isPet)` 喂入决策器。
- tick 中比对「认知态 vs 实测态」：`interState=false 且实测命中 pet` = 捕获失同步铁证（连续 2 拍防抖）→ toggle-through 重申；`interState=true 且实测非 pet` 仅作调试记录（光标可能在死区/副屏，不误报）。
- 决策器新增**稳态重申**：距上次 apply 超 5s 即重申当前态（覆盖一切未观测重置路径；距上次 apply <1s 避让，不与 toggle-through 打架）。
- 窗口 'move'/'resize' 事件 → 立即重申当前态（移动重置的通用兜底，含 wiggle）。

### 设计 3：wiggle 修正

- 触发条件改为**冻结正向证据**：主读数静止（cursorMoved 恒 false）累计 60s **且**外部探针新鲜且在移动 → 才判定真冻结并 wiggle；正常静止（外部探针也静止）不触发。
- wiggle 完成后 350ms 由决策器强制重申当前穿透态（retryEpoch 防过期重放）。

### 设计 4：渲染层缺位防御（boot.js / stage.js）

- initStage 失败不再阻断 initInteract：stage 抛错路径改为挂 nullModel 空壳（focus/motion/expr 全容忍）+ 可视错误提示，boot 继续装配交互层——模型画不出时穿透/解锁/面板体系依然完整在位。
- 渲染层缺位不再是看门狗盲区（设计 2 的 X 层证据链与渲染层解耦）。

### 设计 5：spawn 日志落盘（废 stdio:'ignore'）

- index.js spawnPet：stdio 改为 ['ignore', fd, fd]，fd=DSH_HOME/live2d-companion/pet.log（append）；超 1MB 轮转为 pet.log.old。全平台统一（Windows 同受益，零行为差异）。

### 设计 6：宿主重生修正

- 凭据 JSON 增 `passthroughProvenAt`；schedulePetRespawn 读取上次凭据：若上一实例「未证实穿透即死亡」→ 计入 sickRespawn，连续 2 次暂停重生并 warn（区别于崩溃循环的 3/h 滑窗，语义=带病启动保护）。
- 配合设计 1：即使误判多杀，新实例不显示即无害，灾难循环在结构上消失。

### Windows 零回归论证（逐点）

| 改动点 | Windows 影响 |
|---|---|
| show:false + 证实门 | isIgnoreMouseEvents() 读回即真，证实延迟 <10ms，仅 show 时机略延后，无语义变化 |
| xdotool 探针/命中读回 | linux 分支，不启用（现状已是） |
| 稳态重申（5s） | setIgnoreMouseEvents 同值重申在 Windows 幂等无害 |
| move/resize 重申 | 事件在 Windows 同语义存在，重申幂等 |
| wiggle 条件修正 | wiggle 仅 Linux 提供钩子，不涉及 |
| boot/stage 容错 | 仅新增 try/catch 与空壳，成功路径逐字节不变 |
| 日志落盘 | 由 stdio ignore 改为文件，纯增益 |
| 凭据新字段 | 读取方做可选字段处理，旧凭据兼容 |

## 阶段三·施工记录（2026-09-13 00:45–01:35，第五轮 Oracle 续作收口）

### 0. 现场盘点与遗产收编

- 前任第四轮落码六设计全部在位（显示门/X 校验环/wiggle 修正/渲染层缺位防御/spawn 日志落盘/带病重生修正），语法与既有测试全绿，**收编不重做**。
- 紧急处置：前任 00:29:20 sed 翻转的 pet:true 残留已改回 **pet:false**（纯配置热重载，未碰任何进程）；生产 dsh web（pid 85046，3080 LISTEN）健康。
- 铁律追加（前任死因）：**禁止对进程组发信号**（kill -- -pgid 一律禁用；detached 桌宠 ppid 仍是 dsh web，杀「父进程组」= 灭宿主全组）；清理只用精确 pid。

### 1. 未爆弹 T7 根因定论（三枚真弹 + 一枚哑弹，全部实证）

**哑弹（T7「映射 1s 后窗口消失」本体）**：不是自毁 bug，是证实门失败路径按设计工作——启动期盲写被导航重置时，证实门命中本窗 → hide 收拢 → 重申 → 重试 re-map，进程始终存活。第五轮实验室 pet6 完整复现该路径（`passthrough proof FAILED ... window hidden, reasserting and retrying` → 重试后 `proven`）。前任在重试循环中途杀死会话，未看到自愈完成。

**真弹一：reparenting WM 框架/客户窗失配（fail-closed 静默失效，最危险）**。
openbox 实证：窗口被 reparent 后 `XQueryPointer().child` 与 `xdotool getmouselocation WINDOW` 返回的是**框架窗** id（客户 0x2006ef vs 框架 0x2006ee），而 `getNativeWindowHandle()` 给客户窗 id——第四轮代码直接等值比较，捕获态下「框架≠客户」恒判非本窗 → **证实门假通过、X 校验环全盲**，整套 fail-closed 在 reparenting WM（openbox 实证；mutter 同类语义）下静默退化为纯盲写。GNOME 上 T7「proven 0ms after map」的即时通过高度疑似同源。
修复：一次性解析 `xwininfo -root -tree` 取客户窗的 root 直子祖先（petTopWid），命中判定改为「客户窗 ∨ 框架祖先」；无 reparent 时 petTopWid=petWid，行为与旧比对逐字节等价。**时机铁律：必须 map 后解析**（reparent 发生在 map 时，提前解析会把 petTopWid 误钉成客户窗——第五轮首轮施工踩中并修正）；证实落锤前 force 重解（pet6 实证 hide/show 重试循环会换框架 id：0x2008bc→0x200909，被 markProven 的 force 重解正确捕获）。

**真弹二：安全态 60s 盲写裸奔**。safeMode 分支早退 tick，把稳态重申一并跳过——入态时的一次性 apply(true) 若被其后的移动/最小化还原重置，60s 内捕获无人续写（实验室实测安全态内 lastApplyAge 7933ms > 5000ms 无重申、命中持续回本窗）。
修复：安全态内同样执行周期重申（`if (now - lastApplyAt >= reassertMs) applyPassthrough(true)`），恒穿透承诺改为续写语义。

**真弹三：minimize/restore 是未登记的穿透重置矢量**。move/resize 有 reassert，最小化还原没有——实验室实证 minimize→guard restore 后命中回本窗。
修复：`win.on('restore') → passthrough.reassert()`（两形态同改）。

**附带：证实门陈旧探针竞态**。hide 后重新 show 的拍里，探针读回可能是隐藏期旧值（命中≠本窗）被计为证实票，理论可两连陈旧假通过。
修复：证实判定要求 `lastProbeAt > proofShownAt`（读回必须新于本次显示）。

### 2. 第五轮修复清单（pet/main.js 与 standalone/main.cjs 同步，passthrough.cjs 共享）

| # | 位置 | 改动 |
|---|---|---|
| 1 | pet/main.js + standalone/main.cjs | petTopWid 框架祖先解析（xwininfo tree，map 后首拍 + markProven force 重解，工具缺失降级旧行为）+ isPetHit 双 id 判定 |
| 2 | 同上 | 证实门陈旧读回竞态修复（lastProbeAt/proofShownAt） |
| 3 | pet/passthrough.cjs | 安全态内稳态重申；reassertMs 纳入 tuning（离线验证注入用） |
| 4 | 同 1 两形态 | win.on('restore') → reassert（minimize/restore 重置矢量登记） |
| 5 | pet/main.js（standalone 同语义） | L2D_DEBUG=1 下落 `resolved window ids: client=0x… top=0x…`（现场取证用） |

### 3. 实验室验证记录（Xvfb :99 1920x1080x24 + openbox reparenting WM；WebGL blocklist = 22:51 事故环境复刻；页面服 standalone-server.mjs:8092 模拟宿主）

| 验证项 | 方法 | 结果 |
|---|---|---|
| 事故环境 fail-closed | WebGL blocklist 下冷启动（渲染层缺位） | ✓ headless 降级装配 → `passthrough proven (x11 hit-test)` → 命中全程 root（不捕获） |
| show 瞬间即穿透 | 100ms hitwatch 自 spawn 起监视 | ✓ 证身后全程 child=root；证明前的亚秒级失守由证实门收拢（设计语义） |
| 证实门失败路径 | swiftshader 重型启动（导航重置盲写） | ✓ `proof FAILED → window hidden → reasserting → retry → proven`，进程存活 |
| 框架失配修复（决定性） | CDP `__petBridge.setIgnore(false)` 强制捕获 | ✓ 修复前校验环恒 isPet:false（全盲）；修复后 `desync: passthrough believed but X hit-test lands on pet window` 开火，2.8s 内愈合并回穿透 |
| 双证据链 | 同上强制捕获 | ✓ 渲染层反向核验与 X 层命中校验各自独立捕获同一失守 |
| move 重置 | xdotool windowmove | ✓ 瞬时捕获（150ms 采样=框架）→ 1.2s 内 move-reassert 愈合 |
| minimize 弹回 | xdotool windowminimize | ✓ `minimized by WM, restoring` + IsViewable；并实证 restore 重置矢量（真弹三发现现场） |
| 安全态裸奔修复 | 三连强制捕获 → 安全态 → 态内 windowmove 破形 | ✓ 态内 lastApplyAge 周期循环（重申续写）→ 6s 内愈合（修复前 60s 无人重申） |
| dwell 进出交互（swiftshader 模型加载） | xdotool 光标停模型中心 (1781,843) | ✓ 2s 内命中=pet 框架（交互放行）；按钮簇 chrome/pin visible；移出 2s 回收穿透 |
| 锁钮三态 | 真实 xdotool 点击 | ✓ 锁定→模型区恒穿透+锁钮常驻；悬停锁钮→UI 即时可点；点击解锁→dwell 放行恢复 |
| 离线验证 | /tmp/passthrough-verify.mjs | ✓ **41/41**（新增 ⑱ 安全态稳态重申 ×3） |
| 单元测试 | node --test | ✓ pet-lifecycle 20/20、gomoku 27、chess 24+8、llm-duel 17 |
| 语法 | node --check 全部改动文件 | ✓ 全过 |

### 4. Windows 零回归论证（第五轮补丁逐点）

| 改动点 | Windows 影响 |
|---|---|
| petTopWid 解析 | 整段 `process.platform === 'linux'` 守卫（resolvePetTopWid 首行即返）；Windows 不触碰 |
| isPetHit 双 id 判定 | 仅 Linux 证实门/探针路径调用；Windows 证实门走 `passthroughProven = true` 初始分支，原行为 |
| 陈旧读回字段 | 仅 Linux 探针回调写入，Windows 无探针 |
| 安全态稳态重申 | setIgnoreMouseEvents 同值重申在 Windows 幂等无害（与既有 5s 稳态重申同性质） |
| restore 重申 | Windows 无框窗可触发 restore（任务栏还原等），重申幂等无害；reassert 300ms 防抖 |
| reassertMs tuning | 默认常量不变，生产路径零差异 |

### 5. 施工进度（交接锚点）

- **当前状态**：全部代码修复落盘未 commit；实验室全绿；生产 pet:false 禁闭中，dsh web 健康。
- **下一步（明早用户在场）**：阶段4 金丝雀——先起真屏守护（500ms query_pointer 轮询，非穿透>3s 按精确 pid 扑杀实验实例，**严禁进程组信号**），再翻转 cordis.patch.yml pet:true 让生产 spawn 一次，X 层实证穿透+用户真鼠标验收（锁钮/面板/dwell），守护撤收后保持 pet:true。
- **金丝雀失败预案**：扑杀实验实例 → pet:false 复原 → 读 ~/.dsh/live2d-companion/pet.log（spawn 日志落盘已就位）→ 不得连续强试。
- **遗留**：① GNOME/mutter 是否 reparent 未实测（金丝雀时以 `resolved window ids` 日志一行定论——top≠client 即 reparent，修复已覆盖两种世界）；② 证实门重试循环的亚秒级 re-map 暴露窗（失守会话里 ~500ms/拍占空比，自愈且有终，可接受）；③ WM 崩溃重启导致框架 id 变更的场景未覆盖（稳态重申 5s 兜底，hit 校验降级为旧行为不失效）；④ wiggle 探针在锁屏期（外部探针也静止）不触发，属设计语义。

---

# 第五轮补·金丝雀实录（2026-09-13 12:11–12:18）与第六轮：SwiftShader 高烧 + 看门狗振荡环（12:40–13:35 收口）

## 金丝雀实录（阶段4 执行结果）

守护 v3（/tmp/l2d-guardian-v3.py：框架感知+精确 pid；遗产 v2 两处违铁律——`kill -9 -- -pid` 进程组信号、只比客户 id 在 reparenting WM 全盲——未采用）武装下两轮生产 spawn：

| 轮次 | 结果 |
|---|---|
| 12:12（pid 679415） | 证实 1.87s 落凭据；守护：map→409ms 观测到穿透（启动瞬态有界自愈）；**GNOME/muffin reparent 定论=False**（client=top=0x08600004，框架修复在本机零差异、reparenting WM 上救命）；12:13:45 wiggle 重置 → **X 校验环生产首开火**（desync: X hit-test lands on pet window）1s 自愈；发现会话级 WebGL blocklist → headless（fail-closed 验证过但桌宠隐形） |
| 12:18（pid 684605，携 enable-unsafe-swiftshader 新码） | **map 首拍即穿透（0ms after map）**、证实 1.73s、`stage init failed` 消失（SwiftShader 救回模型渲染） |

## 第六轮症状（金丝雀放行 24 分钟后爆发）

桌宠 GPU 进程 **385% CPU**（`--use-angle=swiftshader-webgl`），load 24.8，cinnamon 46% 合成风暴伴生；pet.log 出现 **wiggle→desync→safe mode→复发振荡环**（UTC 04:33–04:40 三轮完整周期，safe mode 到期与 wiggle 同毫秒即复发）。

## 第一步·退烧（12:43 完成）

pet:false 热重闭（宿主 killPetTree POSIX 分支负 pid 杀的是 detached 桌宠**自成**进程组，pgid 对账=684605 全家无误伤）。家族 42s 内全退场，GPU 385% 消失，load 24.8→15.7 回落。

## 第二步·GPU 根因（宿主级，非仓内 bug）

取证链：`glxinfo -B` → **llvmpipe（Accelerated: no）全会话软渲**；i915 内核侧完好（GuC/HuC 固件加载、/dev/dri ACL 有 桌面用户 rw、logind active）；`LIBGL_DEBUG=verbose` → **"screen 0 does not appear to be DRI3 capable"**；Xorg.0.log → **/etc/X11/xorg.conf.d/20-intel.conf（2026-09-12 22:44 创建=重启前 4 分钟）强制 intel DDX**，2021 年的 xserver-xorg-video-intel 2.99.917 对 Alder Lake-P [8086:46a6] 报 **"Unknown chipset"** → 不初始化 DRI3/glamor → 全会话 llvmpipe。

**22:51 事故史前传补完**：这份 22:44 写入的 Xorg 配置 = 会话软渲 → cinnamon 高烧基线 + Chromium GPU 进程初始化失败（viz_main_impl 报错退出）→ WebGL "blocklisted"（实为无 HW GL）→ 桌宠 headless ——与启动期穿透失守叠加成事故。两个独立缺陷（宿主 GL 退化 + 桌宠启动盲窗）复合成灾。

**处置决策**：`ignore-gpu-blocklist` 对本症**无效且不加**（阻塞在 DRI3 缺失的 GPU 进程初始化层，非 blocklist 判定层）。宿主根治=删/改 20-intel.conf + 重新登录（会杀当前会话含 dsh web GUI），**交用户定夺不代执行**。仓内做三层防御（下表 #1#2 与振荡环拆除）。

## 第三步·修复清单（第六轮，两形态同步）

| # | 位置 | 改动 |
|---|---|---|
| 1 | pet/main.js + standalone/main.cjs | `appendSwitch('enable-unsafe-swiftshader')`：HW GL 优先，仅放行软件回退（金丝雀实证救活模型渲染） |
| 2 | public/src/stage.js | **软件渲染 FPS 自保**：检出 SwiftShader/llvmpipe/softpipe（WEBGL_debug_renderer_info）即本会话压 saver 档（15/8/4fps），不持久化、面板可超越——385% 高烧对冲 |
| 3 | pet/passthrough.cjs | **振荡环三断点**：① wiggle 自残静默窗 3s（quietHit **只延不缩**，X 层命中+渲染层反向核验双通道豁免）；② wiggle 疗效上限 3 次→停用（外部探针全权接管，主读数真动清零计数）；③ 安全态退避（5min 内再进 ×2 上限 8×）+ 退出 hysteresis（lastMainMoveAt 重置，防到期同毫秒复发） |
| 4 | pet/passthrough.cjs | **reassert 升级 toggle-through 300ms**：同值重申被 Electron 去重吞掉（X 层被移动重置后同值写毫无效果）；120ms 短脉冲实证不足以重发 XShape（实验室对照） |
| 5 | pet/passthrough.cjs + 两形态 wiggle 钩子 | **wiggle 重申编排**：muteReassert(500ms) 静音事件重申 + 往返落地后 reassertNow 无防抖一刀收尾（往返 300ms 与防抖 300ms 病态对齐：去程 toggle 在返程重置前空放、返程后双双饿死——pet13 实证 3s 不愈合） |

**振荡环根因定论**：wiggle 自移必然重置穿透（移动重置矢量）→ 命中校验把自愈期捕获计为 desync（每 wiggle 一发）→ 3 发进安全态 → 到期同毫秒 freezeProbe 再 fire（主读数从未真解冻）→ 环闭环。五处修复叠加后实验室终验：**wiggle 点火 → ~700ms 编排内自愈 → 零 desync 零 safe mode**（pet14 日志）。

## 第四步·验证记录

- 离线验证 **51/51**（新增 ⑱ 安全态重申 ×3、⑲ 振荡不成立 ×7：自残静默/疗效上限/退避/hysteresis/reassert toggle 断言）。
- 单元全绿：pet-lifecycle 20/20、gomoku 27、chess 24+8、llm-duel 17；node --check 全改动文件过。
- 实验室（Xvfb :99 + openbox，SwiftShader 软渲=生产同症）：pet7–pet14 八轮迭代，每轮抓一个真问题（同值吞写 → 120ms 不足 → quietHit 覆盖竞态 → 反向核验误计 → 编排防抖饿死），终版 pet14 全绿：证实门通过、软件 GL 检出上报、maxFPS=15 钳制、wiggle 零代价、dwell/锁钮回归正常。
- **金丝雀再放行实录（13:38–13:43，守护 v3 武装）**：
  - **穿透安全：全绿**——map→passthrough 2ms；4 次 wiggle 各产生 0.4–0.8s 捕获瞬态全部编排内自愈，**pet.log 零 desync 零 safe mode 零振荡环**（对照第六轮前：每 wiggle 一发 desync、3 发进 safe mode、到期同毫秒复发）；守护阈值 3s 从未接近；证实门 5.3s 通过（含一次失败收拢重试，守护如实记录 window gone 瞬态）。
  - **CPU 水位：不达标（失败预案执行）**——GPU 进程 6×30s 采样恒 **373%**，Saver 档 15fps 钳制**未降压**：高烧源不是 PIXI 帧率而是 **llvmpipe 会话下全屏透明窗的软件光栅化**（合成器帧率驱动，与 ticker 无关），<100% 硬指标在软渲会话结构上不可达。13:43 按预案 pet:false 扑杀复原（家族 12s 退场，load 21→15 回落），**不连试**。
  - **终审结论**：穿透安全链全绿可放行；但**经济性否决**——桌宠在宿主 GL 根治（删/改 20-intel.conf + 重新登录）前不上真屏。用户四连终审随 GL 根治后的金丝雀一并进行。
  - **金丝雀副产品（疗效计数漏洞，已修）**：wiggle 捕获窗内真实事件流入造成主读数短暂解冻，把 wiggleFails 反复清零（4 次 wiggle 未触发停用）——`wiggleFails` 清零改为只认静默窗外的真解冻（passthrough.cjs tick），离线 51/51 保持全绿。

### Windows 零回归论证（第六轮逐点）

| 改动点 | Windows 影响 |
|---|---|
| enable-unsafe-swiftshader | 仅放行软件 WebGL 回退，HW GPU 优先不变，正常机器零差异 |
| 软件渲染 FPS 钳制 | 检出正则只在软件后端命中；硬渲零影响；软渲（RDP 等）压帧同属受益 |
| 振荡环三断点/quietHit/编排 | 纯决策器内部状态机；wiggle 钩子 Windows 不提供（linux 守卫），退避/静音逻辑平台无关 |
| reassert/reassertNow toggle-through | Windows 同值重申幂等，toggle 等效多一次反向写（与既有 desync 同规格），无害 |

## 施工进度（第六轮交接锚点）

- 当前：全部修复落盘未 commit；实验室+离线全绿（51/51）；生产 **pet:false**（经济性否决态，穿透安全链已证绿）；dsh web 健康。
- 下一步（**用户行动项**）：删/改 /etc/X11/xorg.conf.d/20-intel.conf（Driver 改 "modesetting" 或整文件移除）+ 重新登录 → 会话恢复硬件 GL（glxinfo 应显示 Iris Xe 而非 llvmpipe）→ 金丝雀终放（守护先行，规程同前）→ 用户四连终审 → 全绿保持 pet:true。
- 遗留：① 软渲会话 saver 档 15fps 无法压住全屏透明窗的软件光栅化（合成器帧率驱动，与 PIXI ticker 无关）——若未来必须支持软渲会话，唯一出路是窗口从全屏改为模型包围盒尺寸（架构级改动，未做）；② wiggle 停用后决策由 500ms 探针全权接管（33ms 顺滑度降级，功能无损）；③ 各层软渲防御（SwiftShader 开关/FPS 钳制）在 GL 根治后建议保留（纵深）。

---

# 终局：GL 根治后金丝雀终放（2026-09-13 16:33–17:00）

## GPU 平反验证（过关放行）

- 用户已完成注销重登并重启 dsh web。`glxinfo -B`：**Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2)，Accelerated: yes** ✓
- Xorg.0.log：modesetting DDX 加载、**glamor X acceleration enabled on Iris Xe** ✓；注意 `(WW) modeset(0): Option "TearFree" is not used`——20-intel.conf 里的 TearFree 选项未被 modesetting 识别（用户原本的防撕裂意图未生效，仅观察记录，不影响本任务）。
- 20-intel.conf 已被用户改写（.bak-20260913 备份在侧）。

## 金丝雀终放实录（三轮 spawn，守护 v3 全程）

| 时刻 | 事件 |
|---|---|
| 16:34:08 | spawn（pid 6855）：proven +1.7s；守护 map→passthrough 0ms |
| 16:34:46-54 | 早期交互期 5×`interactive but no input reached renderer`（均 #1 未累计，输入证据核销正常） |
| 16:36:29-33 | **真失守事件**：interState=false 但 X 层捕获 3.2s——desync#3 进安全态，但**入态同值 apply(true) 被 Electron 去重吞掉未愈** → 守护按设计精确 pid SIGTERM 扑杀（6855 干净退场）。**守护有效性实证 + 新 bug 实证** |
| 16:37:03 | 宿主 M3 重生（前实例有 passthroughProvenAt 非 sick）；证实门经历一次失败收拢重试后 proven |
| 16:38-41 | 两次 wiggle 后 **wiggle ineffective 3x → disabled**（疗效上限正常收官）；期间 wiggle 瞬态全自愈、零安全态 |
| ~16:44 | **安全态入态改 toggle-through + 态内 X 校验兜底**落码（16:36 事件的修复）；离线套件回迁入仓 `pet/passthrough-verify.mjs`（/tmp 被重启清空的教训），扩至 **55/55 全绿**（新增 ⑱c 态内校验、⑲b2 静默窗外才清零疗效） |
| 16:48:37 | 终码重生（pid 17991）：map→passthrough 403ms（启动瞬态有界自愈）；minimize-guard 拦下一次 WM minimize；本世代 pet.log **零振荡环条目** |

## CPU 水位（硬指标全过）

| 指标 | 软渲会话（否决时） | 硬渲会话（终放） |
|---|---|---|
| pet GPU 进程 | 373–385% | **52.3–52.6%（6×30s 稳态）** ✓<100% |
| pet 主进程 | 26%（renderer） | 3.2–3.3% ✓ |
| cinnamon | 46–59%（合成风暴） | ~20.9% 正常 ✓ |
| load average | 21–24 | 2.0–2.7 稳定 ✓ |

（采样插曲：GPU 进程启动期换新过一次（17866→18027），前 5 分钟表格空列，以 18027 补采 3 分钟为准。）

## 守护规程教训（已执行）

- 守护把「合法交互态」（dwell 放行/面板使用）与「失守捕获」同视为 CAPTURING——终审期已切 **no-kill 纯监视**（/tmp/l2d-guardian-v3.py 第二参数），终审通过后守护撤收（守护本就是测试期工具）。
- 终态：pet:true 保持中；用户四连终审 verdict 待收。
