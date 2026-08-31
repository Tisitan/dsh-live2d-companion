# dsh-live2d-companion 深度代码审查（2026-08-30）

- 审查基线：工作树现状（线上运行即工作树）。HEAD=`44a1db4`，13 个已跟踪文件 +589/−253 未提交；`games/wordvoyage/`、`public/src/games/wordvoyage*.js`、`public/wordvoyage-words.json` 未跟踪。
- 审查动因：当日 16:37 桌宠 Electron 渲染器崩溃后被 Chromium 以 `--renderer-client-id=14` 重启，但 pet.html 未加载（新渲染器 4.8h 仅 8.45s CPU、userData 零写入），窗口壳（透明/置顶 overlay）照常存活 → 「壳活页死」，且 `pet/main.js:300-308` 既有自愈监听未兜住。
- 性质：只审查，未改任何源码。

---

## 一、Critical

### C1 「壳活页死」：四条自愈腿全是被动事件/错位探针，对该故障类架构性不闭坏

**证据**：`pet/main.js:293-333`（自愈链全文）、`:306-308`（gone/unresponsive→quit）、`:53-59`（will-quit 删凭据）、`:321-333`（健康自尽）。

#### 1.1 为什么 render-process-gone 没触发 app.quit

先排除一种可能：事件派发了但 quit 失败。`app.quit()` 无 before-quit 阻塞点，will-quit 回调（:53-59）只做属主校验后的文件删除，不构成退出障碍——**「事件来了但没退」基本可排除，结论指向事件根本未派发**。候选场景按可能性排序：

- **候选 A（主判）：崩溃发生在渲染器 launch/导航提交前，Chromium 对「未完成 startup 的进程死亡」静默重试新进程，不上报 RenderProcessGone**。新渲染器 client-id=14 存在却 4.8h 零工作（8.45s CPU、userData 零写入 = 页面 JS 从未执行、localStorage LevelDB 零落盘），与「新渲染器停在 launch/about:blank、从未收到加载 pet.html 的指令」完全吻合。此场景下 Electron 的 webContents 级 `render-process-gone` 无从派发（渲染器「没死」，只是从未活过）。
- **候选 B：死亡进程不是主 frame 渲染器**（GPU/utility/pending 渲染器被连带），`win.webContents.on('render-process-gone')` 只覆盖本 webContents 主渲染器；全局兜底 `app.on('child-process-gone')` 未监听（全文件无此注册）。
- **候选 C（低概率）：reason=killed（OOM/外部终止）**。killed 同样会派发 render-process-gone，若派发则必 quit，故与现象矛盾，仅作为「事件派发但主进程当时异常」的尾部保留。

**可执行取证**（复现时）：`L2D_DEBUG=1` 启动（`pet/main.js:10-12` 已支持 9222 调试口），用现成的 `pet/cdp-probe.mjs` 查 client-id=14 渲染器的 target URL——若为 `about:blank`/`chrome-error:` 即坐实候选 A；同时加 `child-process-gone` 日志等下次复现。

#### 1.2 四条自愈腿逐条失效场景

| 腿 | 位置 | 失效场景 |
|---|---|---|
| render-process-gone→quit | `pet/main.js:307` | 候选 A/B 场景根本不派发；且处理器无日志，连「它来没来过」都无法事后取证 |
| unresponsive→quit | `pet/main.js:308` | **结构性失效（装饰品）**：unresponsive 由窗口收到输入事件且渲染器无响应驱动；overlay 是 `setIgnoreMouseEvents(true)` 全屏穿透 + `skipTaskbar` + 永不聚焦（:90），永远收不到输入事件，此事件在该窗口形态下不可能触发。自愈链的第二条腿从未真正存在 |
| did-fail-load 指数退避 reload | `pet/main.js:300-305` | 只在「发起了导航且导航失败」时派发。页死场景里没有任何人再发起导航：初始 loadURL（:309）早已完成，退避链因 did-finish-load（:305）清零后进入睡眠，健康检查 reload 要 failures≥10 才触发——而下一条证明它到不了 10 |
| 健康自尽（fetch /live2d/state） | `pet/main.js:321-333` | **探针错位**：fetch 由主进程网络栈直连宿主 HTTP，完全不经过页面渲染器。「宿主健康 + 页面死亡」时 failures 恒 0，reloadPage（failures≥10）与 quit（failures≥15）永不触发。本次 4.8h 隐形正是实证：宿主一直健康 |

结论：**三条事件腿被动等待、一条探针链探错了对象**。「壳活页死」这个故障类（渲染器存活但页面未加载 / 渲染器静默重建）在现有架构下没有任何一条链能观测到，只能靠 `render-process-gone` 恰好派发这一条窄路。今日它没来，事故就发生。

**独立版更弱**：`standalone/main.cjs:146-147` 只有 gone/unresponsive→quit，连 did-fail-load 退避与健康检查链都没有，壳活页死风险面 ≥ 桌宠版。

#### 1.3 兜底方案（与既有链路兼容）

**L1（闭环关键）主进程主动探活，两案任选：**

- **方案 A'（最小侵入，推荐先落）**：`public/boot.js` 入口处置一行页面存活标记（如 `window.__L2D_PAGE_LIVE = true`）；主进程在既有 8s 健康 interval（`pet/main.js:322-333`）内加探针：

  ```js
  // 与 failures 探针同一个 setInterval 内：
  let pageMisses = 0
  // 每 tick：
  const alive = await Promise.race([
    win && !win.isDestroyed()
      ? win.webContents.executeJavaScript('window.__L2D_PAGE_LIVE === true').catch(() => false)
      : Promise.resolve(false),
    new Promise(r => setTimeout(() => r(false), 4000)),
  ])
  pageMisses = alive ? 0 : pageMisses + 1
  if (pageMisses === 2) reloadPage()      // 先自愈：复用既有 reloadPage+loadRetries 退避语义（:296-305）
  if (pageMisses >= 5) app.quit()          // ~40s 仍页死才退出，宽限与健康自尽 15×8s 同级
  ```

  探针语义说明：`executeJavaScript('1')` 探不出本故障（对 about:blank 也返回成功），**必须探页面自身的标记**——页面没加载时返回 false，正好命中「渲染器活着但页死」。崩溃瞬间 executeJavaScript 可能挂起，race 超时兜住。
- **方案 A（标准 IPC 心跳）**：`pet/preload.js` 增 `heartbeat: () => ipcRenderer.send('l2d-heartbeat')`；渲染层 5s 周期上报；主进程记录 lastBeat，同位置做 miss 判定。语义最直白，且天然覆盖「页面 JS 完全没跑」。

**兼容性论证（对任务书点名链路逐条）**：
- **did-fail-load 退避（:300-305）**：探活失败的 reload 复用 `reloadPage()`，`loadRetries` 退避语义原样生效；reload 成功 → did-finish-load → 新页面 boot.js 重新置位 → miss 清零。两条链共享同一个 reload 入口，互不干扰。
- **PID 凭据（:41-59 + pet-lifecycle.mjs:71-93）**：探活致 quit → will-quit 属主校验删凭据 → 宿主下次 spawn/收养判定按既有 stale 逻辑自愈，无新增状态。唯一依赖：**宿主侧必须有人重新拉起**（见 M3，当前是空窗，两修需联动）。
- **健康自尽（:321-333）**：正交双链——8s 链探宿主（fetch），心跳链探页面（executeJavaScript/IPC）。合并进同一 interval 实现，failures 与 pageMisses 各自独立计数。宿主死时 failures 链照旧工作；宿主活页死时心跳链接管。
- **误报面**：`backgroundThrottling:false`（:86）保证渲染器计时器/页面标记不被节流；系统睡眠恢复后首轮 miss → 一次无害 reload；阈值（2 miss 才 reload、5 miss 才 quit）留足宽限。

**L2 全局兜底**：app 顶层加 `app.on('child-process-gone', (e, d) => { if (d.type === 'Renderer') 记日志并按 reason 决策 reload/quit })`，覆盖候选 B 及一切 webContents 级事件漏网。

**L3 取证日志（零成本，立即做）**：`render-process-gone`/`unresponsive` 处理器（:306-308）加 `console.error('[l2d-pet] render gone:', details.reason, details.exitCode)`——本次事故最大的排查障碍就是这条链完全静默。

**工作量**：方案 A' ≈ 1-1.5h（boot.js 1 行 + main.js ~20 行）；方案 A ≈ 2-3h（preload/渲染层/main 三处）。独立版 standalone/main.cjs 补同款探活 + 退避链 ≈ +1.5h。

---

## 二、Major

### M2 卡窗（cardWins）崩溃监听缺口：卡窗版「壳活页死」，且白屏窗钉死屏幕不可自愈

**证据**：`pet/main.js:205-263`（卡窗仅有 setWindowOpenHandler/will-navigate/did-finish-load/resize 看门狗/closed）、`standalone/main.cjs` 同段（多窗改造后同样缺失）。

**风险面**：卡窗渲染器崩溃/页面未加载后——× 按钮是页面 DOM（`public/game-card.js:18-20`），页面死则无法关窗；拖动依赖页面 pointerdown→IPC moveBy（`game-card.js:37-56`），页面死则拖不动；overlay 死区推送仍含死窗矩形（`pet/main.js:165-172` 只按 `win.isDestroyed()` 过滤，窗壳不死就照推）→ 那块屏幕区域点击被吃、下层不可达。用户唯一出路是任务管理器杀整个桌宠——比 overlay 隐形更糟：**一块不透明白窗常驻屏幕且不可交互**。崩溃概率面还随窗口数线性放大（每游戏一窗）。

**补齐方案**（`pet/main.js:237` will-navigate 注册之后插入，standalone 同步）：

```js
cardWin.webContents.on('render-process-gone', (_e, details) => {
  console.error('[l2d-card] render gone:', gameId, details.reason, details.exitCode)
  cardWin.close()   // 不必 app.quit：closed 钩子（:257-261）自会清表 + pushCardArea 收缩死区，🎮 可原样重开
})
cardWin.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
  if (!isMainFrame) return
  // 有限退避（≤2 次仍败 close()）：卡窗没有「宿主未就绪」的长等待诉求，失败了就该体面退场
})
```

卡窗 `focusable:true` 有真实输入，`unresponsive` 在此有意义，可选加 unresponsive→close()。修复后「残骸条目」分支（:194-195）与 closed 清表（:257-261）已闭环，无需再动。

**工作量**：两宿主共 ~1h。

### M3 PID 收养机制存在「桌宠没了，宿主永不复活」空窗——现状语义不可接受

**证据**：`index.js:1390-1439`（spawn 节流 + child exit 仅记日志 :1432-1437）、`pet/main.js:331-332`（健康自尽注释自称「宿主下次启动会重新 spawn」）、宿主无任何周期性看门狗（全文件无针对 pet 的 setInterval）。

**裁决**：不可接受。组合语义漏洞：桌宠因 render-process-gone→quit（自愈设计的主路径）或任何崩溃退出时，宿主进程若继续存活（常态即如此——宿主是长驻 web 服务），`child.on('exit')` 只写一行日志，桌宠永久消失直到 remount/宿主重启。尤其 C1 修复方案把「页死不治」的终态定为 quit，会**放大**这个空窗——C1 与 M3 必须联动落地。且健康自尽注释对「宿主重启会 spawn」的承诺，在宿主不重启的现实里是空的。

**最小修复**（`index.js:1432-1437` 的 exit 处理器内）：

```js
child.on('exit', (code) => {
  if (petChild === child) petChild = null
  if (managedPetPid === child.pid) managedPetPid = null
  ctx.logger.info(`live2d pet exited (pid ${child.pid}, code ${code})`)
  // 意外退场退避重拉：仅当不是卸载流程（dispose 会走 schedulePetKill，managedPetPid 语义已区分）
  // 30s 退避 + 复用 lastPetSpawnAt 节流 + 滑窗上限（如 1h ≤3 次）防 crash loop
})
```

注意与 `schedulePetKill`（:1371-1380）的语义区分：宿主主动处置（卸载）不重拉，意外 exit 才重拉；`lastPetSpawnAt` 30s 节流（:1418-1421）原样复用。更稳的变体：60s 周期看门狗（复用 `findLivePet` 探 PET_PID_FILE，free 且 `petChild===null && managedPetPid===null` 才 spawn），额外兜住「spawn 秒崩」场景，代价是多一个常驻 timer。

**工作量**：exit 退避重拉 ≈ 1h；看门狗变体 ≈ 2h（含与 effect 生命周期的清理联动）。

### M1 WordVoyage 全链就位但服务端从未注册——两个运行形态下整条功能不可达

**证据**：`index.js:9-13` 与 `standalone/server.cjs:161-163` 的 registerGame 名单均只有 gomoku/chess，全项目无任何 `registerGame(wordvoyage)` 调用（grep 全仓证实；`games/wordvoyage/semantic.test.mjs:76` 的 `getGame('wordvoyage')` 断言是在测试内自行注册的，不构成生产接线）。

对照已就位的其余全链：引擎/AI/描述符（`games/wordvoyage/index.mjs:18,25` `supportsRestore:true`）、前端渲染器（`public/src/games/wordvoyage.js`，含 `__l2dPendingRestore` 存档钩子 :547）、存档模块（`wordvoyage-save.js`）、卫星窗尺寸（`pet/main.js:154`、`standalone/main.cjs:18`）、皮肤档案（`game.js:250`）、restore 管道（`index.js` /game/new、`server.cjs` /game/new 同口径）、协议抠标签正则（`index.js` banterOf 已扩 `<guess>/<hint>`）。入口断点有三处互相叠加：①服务端未注册 → /game/list 无词宝、/game/new 400 unknown game；②🎮 菜单无词宝按钮（`panel.js:455-458` innerHTML 仅 gomoku/chess）→ 卫星窗开不了；③即使手拼 `game-card.html?game=wordvoyage`，渲染器可加载但对局永远开不出来。**08-28 双沙盒通过的是引擎与前端（单测/渲染层），生产注册接线缺失属「登记与变更矛盾」，正是任务 6 要求确认的点——结论：矛盾存在**。

**修复**：`index.js:10-13` 与 `standalone/server.cjs:162-163` 各补一行 import+registerGame；`panel.js` 菜单补词宝按钮（复用 GAME_PROFILES.icon 🧭）；`standalone/test.cjs:256-259` 的 /game/list 断言同步加第三项。共 ~0.5h。建议补一条「注册表 vs 渲染器文件 vs GAME_PROFILES vs CARD_SIZES 四方一致性」的守卫测试，杜绝下一个游戏重蹈（~1h）。

---

## 三、Minor

### m1 did-fail-load 未过滤 isMainFrame：子 frame 失败误触发整页退避 reload

`pet/main.js:300-304` 处理器忽略 `isMainFrame` 参数。当前 pet.html 无 iframe，未爆；一旦页面引入任何子 frame 且其加载失败，会被误判为页面级失败触发退避 reload 链。修复：签名加参数，`if (!isMainFrame) return`。0.1h。（standalone/main.cjs 无此链，不涉及。）

### m2 健康检查 fetch 无超时且不等上次完成：慢网络下请求堆积、计数失真

`pet/main.js:322-333`：setInterval 8s 硬触发 async 回调，fetch 无 AbortController；网络栈卡顿时上一请求未决、下一请求已发，并发堆积且 failures 时序失真。修复：每次请求 4s 超时（AbortController + setTimeout abort），或改自递归 setTimeout 循环（上一轮完成才排下一轮）。0.3h。

### m3 interact.js 死区矩形过滤不对称：验了 x/width 没验 y/height

`public/src/interact.js:193-197`（setCardAreas）：`Number.isFinite(r.x) && Number.isFinite(r.width)` 而 r.y/r.height 裸用；畸形矩形在 inCardArea（:210-213）里变 NaN 比较恒 false，死区静默失效。当前唯一生产方是主进程 `win.getBounds()`（四字段恒有限），防御不对称无现网后果。补两字段校验 0.1h。**interact.js 增量整体评估**：本批 21 行改动全部集中在死区多窗重构（:187-216），历史雷区（睡眠唤醒台词排序 :127-152、poke 竞态 :243/:325）未触碰，且新 inCardArea 仅被 evalIgnore（:69-72）消费，与睡眠/poke 状态机无交集——雷区安全。

### m4 /game/new 无 per-slot 互斥：同 gameId 并发开局泄漏 agent handle

`index.js` /game/new 在线分支：`await ctx.agentLoop.createAgent(...)`（:967-1000）期间槽未占位，两个并发 new（双窗各点「新开一局」）都通过 disposeGame 检查 → 后写者覆盖 `gameRefs.set` → 先者的 agent session 成孤儿（不 dispose 不回收）。原单槽版同病，多窗化放大了触发面。standalone/server.cjs 的 new 无 await 段，单线程天然原子，不涉及。修复：handler 开头对 gameId 加 pending 标志（Map<gameId,true>）进行中返回 409，finally 清除。0.5h。

---

## 四、遗留重复债裁决（任务 5）

### d1 `pet/main.js` ↔ `standalone/main.cjs`：卫星窗多窗管理整块重复（实测非空行交集 161 行，其中卫星窗连续块 ~100+ 行）

本次未提交批把同一套 CARD_SIZES/normalizeGameId/cardEntryBySender/pushCardArea/建窗-DPI 治疗链在两个文件各写了一遍（`pet/main.js:144-290` ↔ `standalone/main.cjs:11-31,222-295`），且 M2 的补丁也将被迫双写——**重复税正在按缺陷数复利**。两文件同为 CJS Electron 主进程，收敛零障碍：抽 `shared/card-windows.cjs` 工厂 `createCardWindowManager({ getParentWin, getOrigin, preloadPath, sizes, debugLog })`，产出 { open, close, moveBy, bounds, pushArea, entryBySender }，两宿主各保留 IPC 壳。**建议收敛**。工作量 2-3h（DPI 看门狗行为回归是重点，需双端过 150% 分数 DPI 拖拽/出屏回落用例）。

### d2 `index.js` ↔ `standalone/server.cjs`：对局管线语义级重复（逐行重复 ~122 行；trim 后行集合交集 398 行，含样板噪音）

重复实体：槽表管理（gameRefs/games + lastGameSlot/fallbackSlot）、gameSnapshot/gameStateJson、终局播报（pushGameOutcome/pushOutcome）、restore 管道（逐字同构的 try/catch 弃档逻辑）、槽路由解析正则 `/^[a-z0-9-]{1,40}$/i` ×4 处、banter 正则。但两者运行面根本不同（cordis ctx 路由 vs 零依赖 node:http），**不建议整块收敛**——壳差异会把共享层搅成参数泥球。建议分层：仅把纯逻辑（槽表类、槽 id 解析、终局播报组装、banter 清洗）抽 `games/shared/`（registry.mjs 同域，ESM 双宿主可用；server.cjs 用动态 import 桥接）。工作量 0.5-1d，收益中、风险低，优先级低于 d1，可挂账到下个批次顺手做。

### d3 「最大步骤过滤」正则双拷贝：`standalone/server.cjs:286`（invalidAgentText）↔ `standalone/adapters/opencode-live2d.js:71`（invalidGameReply）逐字符相同

**约束**：`opencode-live2d.js` 经 `install-adapters.cjs:45` 单文件拷贝部署到 `~/.config/opencode/plugins/`，**不能 import 项目内模块**——抽共享包对该对不成立（除非安装器连带拷贝共享文件，破坏单文件部署的简洁）。**裁决：保留双拷贝，用测试防漂移**：`standalone/test.cjs` 增断言——提取两文件的 pattern 字面量（`/\/最大步骤[^\/]+\/i/` 源码文本比对）要求逐字符一致，任一侧改动忘另一侧时测试红。0.5h。这是该债的最优终态：不是消灭重复，而是让重复失步必被捕获。

---

## 五、WordVoyage 免审确认（任务 6）

按约定未审 `games/wordvoyage/` 引擎/前端实现。一致性确认结论：**登记矛盾成立（见 M1）**——registry.mjs 对 wordvoyage 无注册（两侧服务端均未 import 未 register），games/*/index.mjs 未提交变更（chess/gomoku 仅提示词微调，wordvoyage 全新未跟踪）与 registry 新注释契约（supportsRestore/retryHint/多标签协议）描述一致但服务端消费名单未同步。`registry.mjs:24-33` 新增契约注释与 `index.js`/`server.cjs` 的实际消费（restore 管道、banter 正则 `<move|guess|hint>`）已对齐，无第二处矛盾。

---

## 六、修复优先级路线

1. **立即（<0.5h）**：C1-L3 取证日志（:306-308 + child-process-gone）——下次崩溃不再盲查。
2. **本批次（~3h）**：C1-L1 方案 A'（boot.js 标记 + 主进程探活）+ M2 卡窗 gone→close（双宿主）+ m1/m3 两处一行级防御。
3. **紧随（~2h）**：M3 exit 退避重拉（与 C1 的 quit 终态联动，闭环「自愈失败也能满血回来」）+ M1 wordvoyage 注册接线（三处 + 守卫测试）。
4. **挂账**：d1 card-windows 共享工厂（2-3h，M2 类补丁落地前做可省一次双写）、d3 防漂移断言（0.5h）、d2 分层收敛（0.5-1d）、C1-L1 升级为方案 A（可选）。

## 七、总结论

工作树这批 +589/−253 的多窗/多槽/皮肤/存档四件套本身质量扎实：槽路由的代际校验闭环、moveInFlight 防串槽、restore 弃档兜底、DPI 治疗链逐窗化都做得干净，TDZ/竞态排查未发现新增雷（interact.js 历史雷区零触碰）。**但「渲染器会静默假死」这个已被今日事故证伪的假设，仍贯穿整个自愈架构**：四条自愈腿（gone/unresponsive/退避/健康检查）没有一条能观测「壳活页死」这个故障类本身——事故不是意外漏网，是架构必然而今日兑现。同理，卡窗多窗化把同一个盲区复制了三份并放大成「不可关不可拖的白屏钉窗」，桌宠自尽后的宿主空窗则让所有 quit 类自愈的终点是「消失而非重生」。三个 Major 本质是同一个世界观的缺口：**这套系统信任事件推送，而 Chromium 恰恰在某些崩溃路径上不推送**。修复方向明确且便宜：主进程对页面做主动探活（信任闭环从「它会说」改为「我去问」），全链补日志，宿主补一张「意外退场重拉」的安全网。四项做完（~6h），「桌宠隐形 4.8h 无人察觉」这类事故从根上失去发生条件。
