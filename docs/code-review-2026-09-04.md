# dsh-live2d-companion 全方位审查报告（2026-09-04）

> 审查方式：dsh-my-go 四批流水线（explore 结构摸底 → hephaestus ×4 批逐行精读：宿主/前端/standalone/pet+games），全程只审不改。审查基线 = 工作树（注意：`index.js` 有 3 行未提交改动，经定性为**必须保留的活 bug 修复**，见下）。

## 0. 项目形态结论

- 工程本体仅 **70 个 git 追踪文件 / ~260 KB 源码**，其余 44 MB 全是 gitignore 的模型素材。
- 实际结构：根目录 `index.js`（1477 行，宿主插件唯一入口，cordis 契约）+ `public/src/` 前端内核（10 模块）+ 两套 Electron 壳（`pet/` DSH 托管、`standalone/` 独立版）+ `games/` 宿主侧游戏内核。
- 插件注册走 `package.json` → `dsh.bundle.patch` → `cordis.patch.yml`，**无 manifest.json**。
- `index.js:780-782` 的未提交改动（`session.snapshotEvents()` 特性探测）是修复 HEAD 版本「在线对局全废」的活 bug 修复，**建议尽快提交**。其中 `?? session.events` 死分支待最低支持版本抬过 alpha.4 后可删。

## 1. 总账

| 批次 | 范围 | 结果 |
|---|---|---|
| 摸底 | 全仓 195 文件 | 27.4 MB 素材垃圾、双协议实现、打包缺文件 |
| 批 1 | index.js + pet-lifecycle | 🔴×4 🟡×12 🟢×10 |
| 批 2 | public/src 前端 10 模块 | 🔴×2 🟡×7 🟢×若干 |
| 批 3 | standalone/ 全目录 | 🔴×1 🟡×6 + 协议分叉表 + 重复债量化表 |
| 批 4 | pet/ + games/ + 收尾 | 🔴×0（批 3 R1 反向确认）🟡×4 🟢×若干 |

## 2. 🔴 Critical / 高危全清单（7 条）

| # | 位置 | 问题 |
|---|---|---|
| C1 | `index.js:1334-1338` | 静态读流无 error 监听：lstat→open 竞态窗口 + pipe 不转发源流错误 → **uncaughtException 崩宿主进程**（拉贴图时删模型目录即可触发） |
| C2 | `index.js:27,549-556` | 「显示模式切换」在官方一键安装路径上**必然 500**：bundle 层装载不会写入用户 profile 层，`rewriteLive2dConfig` 找不到条目；profile 名 `web` 硬编码 |
| C3 | `package.json:37-49` | 发布包缺 `standalone/preload-card.cjs`（`main.cjs:256` 真实 require）→ 打包后独立版游戏卫星窗静默失能 |
| C4 | `index.js:25,363-380,1127-1134` | `/live2d/import` 单请求 128MiB 全内存缓冲 + 无扩展名白名单 → 模型包可夹带 `evil.html` 在宿主同源 URL 直接执行 |
| R1(前端) | `public/src/game.js:572-578` | 走子失败回滚无槽位守卫：切游戏后旧请求超时进 catch，`rollbackOptimistic` **可误删新局真实棋子**，失败解说污染新对局日志（成功路径 565 行有闸，失败路径没有） |
| R2(前端) | `public/src/interact.js:28` | 穿透白名单漏 `#l2d-game-menu`（panel.js:457 创建）→ 小模型时游戏菜单悬在包围盒外被穿透，**点不动** |
| R1(独立版) | `standalone/main.cjs:222-230` | 卫星窗死区推送整链断裂：`cardWin` 声明在 `l2d-game-open` 回调内（248 行）对 `pushCardArea`/`l2d-game-bounds` 不可见 → **每次 IPC 必 ReferenceError**，独立版 `l2d-game-area` 一帧都发不出去（pet/main.js:163-185 已是修好的多窗版，08-31 多窗重构漏同步 standalone——「单边修复」史复发） |

## 3. 🟡 Major 精选（结构性债务）

### 3.1 三 runtime「单边修复未同步」惯性（全案最大根因）

- `server.cjs` ↔ `index.js` 同一 `/live2d/*` 协议双实现且已分叉：
  - **import**：独立版缺 409 exists/overwrite 确认流 → 静默覆盖磁盘文件（server.cjs:988-989 vs index.js:1102-1131）
  - **model delete**：独立版缺 delete 分支 → 前端删除按钮必 404 且报错误导（server.cjs:957-970）
  - publish 无整包判重（server.cjs:371-377 vs index.js:300-305）
  - POST /state 裸写被 publish 覆盖（server.cjs:801）
  - defaultModel 语义漂移（字典序首个 vs 配置默认）；错误码同因不同码多处
- `pet/main.js` ↔ `standalone/main.cjs` 157 行逐行重复，已产生死区推送（🔴）、`roundedCorners:false` 缺失等分叉
- 「最大步骤」正则双拷贝（server.cjs:286 ↔ opencode-live2d.js:71）靠人肉同步，test.cjs 只断言 marker 不做逐字符一致性断言——**保险丝没装上**
- 结论：抽共享包不可行（opencode-live2d.js 单文件部署约束），正解 = test.cjs 一致性断言 + 卫星窗块抽参数化 .cjs 工厂

### 3.2 panel.js 2018 行上帝文件

| 行号区间 | 职责 | 拆分去向 |
|---|---|---|
| 24-429 | CSS 模板（20% 体积） | `panel.css`（30min 立竿见影） |
| 431-660 | 按钮簇+两级菜单+帮助卡 | `toolbar.js` |
| 662-912 | 台词池编辑器 | `quips-editor.js` |
| 1055-1220 | 角色档案页（STANDALONE） | `profile-tab.js` |
| 1222-1332 | 设置页 | `prefs-tab.js` |
| 1333-1616 | 预览弹窗+绑定编辑器 | `viewer.js` |
| 1618-2018 | chrome 显隐+模型 CRUD+全局键鼠 | `model-panel.js` |

块内重复 5 组：位置钳制 ×5、状态行 setter ×4、stopPropagation 盾 ×6（chat.js:464 有现成 `protect()` 未复用）、fetch 舞步 ×8、外点关闭守卫 ×3。

### 3.3 其余 Major

- **M1** `index.js:883` `p.metadata?.name` 字段漂移（AgentPreset 无 metadata）→ 预设下拉永远显示裸 id，改 `p.name ?? p.id`
- **M2** 每 token 一帧 SSE + 每次一整套聚合计算（index.js:273-287,454-461）→ 首帧转发+节流+同值短路
- **M3** 重挂载僵尸 SSE 连接 + sseClients 泄漏（index.js:490-503）→ dispose 时 `res.end()` + clear
- **M4** 64KB 体积闸 vs 3MB 清洗器天花板互相打脸（index.js:24）；CJK 下 body.length 放行约 3 倍
- **M5** 收养决策链竞态：过期挂载可 kill 新挂载正要收养的桌宠（index.js:1441-1447）；exit 钩子用异步 spawn 兜底是撞运气
- **M6** pet-lifecycle 凭据读失败一律判作废删文件（EBUSY/半截 JSON 不分）+ 非原子写 → 桌宠消失故障面（pet-lifecycle.mjs:7-19,74-77）
- **M7** 工具裁剪 fail-open：带全套宿主工具的 agent 去吃浏览器可控 prompt（index.js:982-987），应降级为离线模式
- **Y2(前端)** 半套后端：独立版下台词编辑器/绑定保存 = 可见的 404 死端，用户得到三次泛化报错而非前置提示
- **Y4(前端)** 3 个常驻 rAF 无 document.hidden 闸烧 CPU；列高魔法数耦合三文件
- **Y5(前端)** chat.js historyRecords + DOM 无界增长
- **Y2(pet)** 死桥 API：preload.js:14 onGameFocus 无发送方无监听方；setFocusable 整链 noop，game-card.js:22-32 悬停武装是无效调用+误导注释
- **Y4(测试)** chess engine.test.mjs:85-103 升变/逼和/送将三处断言退化（作者注释自首）；gomoku/engine.test.mjs:126 有恒真断言
- **M9/M8** pet-lifecycle.test.mjs 断言源码字符串（假红负资产）；README 声称 25s 超时 vs 代码 90s 等文档漂移

## 4. 磁盘垃圾清理（收益 27.4 MB）

| 项 | 量级 | 判定 |
|---|---|---|
| `public/model/nori/` ≡ `public/model/ARGNori_web/` | 13.7 MB ×2 | 逐文件 MD5 全等（后者仅多 cdi3.json）；两个目录同时被引用（index.js:23 vs model-selection.json:2）→ 删一份 |
| `texture_00_corrupt.png` ×3 | ≈13.7 MB | 全仓零引用的死文件 |

## 5. 最终行动清单

### P0 — 正确性（本周内，≈1.5h）

| # | 位置 | 修法 | 工作量 |
|---|---|---|---|
| P0-0 | `index.js:780-782` | 提交未提交的 snapshotEvents 修复 | 5min |
| P0-1 | `standalone/main.cjs:222-230` | 用 pet/main.js:163-185 多窗版整体替换 + 补 roundedCorners:false | 0.5h |
| P0-2 | `public/src/game.js:572-578` | 捕获 reqGame，catch 内先比对槽位（照抄 server.cjs:940 已有守卫） | 0.5h |
| P0-3 | `public/src/interact.js:28` | uiHit 白名单补 `#l2d-game-menu` | 10min |
| P0-4 | `index.js:1334-1338` | 读流补 `.on('error', () => res.destroy())` | 10min |
| P0-5 | `package.json:37-49` | files 补 `standalone/preload-card.cjs`、`standalone/README.md` | 5min |

### P1 — 协议/结构债（两周内，≈2 天）

| # | 位置 | 修法 | 工作量 |
|---|---|---|---|
| P1-1 | `server.cjs:977-995` | import 补 409 exists/overwrite 流，对齐 index.js:1129 | 1h |
| P1-2 | `server.cjs:957-970` | /model 补 delete 分支（或前端独立版隐藏删除钮） | 1h |
| P1-3 | `test.cjs` | 补「最大步骤」正则逐字符一致性断言 + SSE/​profile 路由覆盖 | 2h |
| P1-4 | `panel.js:554,662-912` | 独立版台词编辑器/绑定保存按 STANDALONE 闸入口 | 1h |
| P1-5 | `panel.js` | 按 3.2 边界表拆分（先 CSS 后六模块，顺带消灭 5 组复制粘贴） | 1-1.5 天 |
| P1-6 | `index.js:27,531` | 显示模式切换走 bundle 层语义修复（干净安装 500 根治） | 2h |
| P1-7 | `index.js:1102-1134` | import 加扩展名白名单 + 流式写盘（堵 evil.html 投毒） | 1h |

### P2 — 卫生与体验（排期自由，≈1 天）

| # | 位置 | 修法 | 工作量 |
|---|---|---|---|
| P2-1 | panel.js:644/chat.js:451 + 三处 rAF | 列高常量共享 + document.hidden 闸 | 2h |
| P2-2 | chat.js:87,101-118 | historyRecords/DOM 加 500 条滚动上限 | 0.5h |
| P2-3 | interact.js:131 | 唤醒语迁入 quips 池（新增 wake 池） | 0.5h |
| P2-4 | boot.js:135-151 | 扩展 dispose 生命周期 | 1h |
| P2-5 | package.json:34-36,16 | files 移出 restart-dsh-web.ps1（含硬编码本机路径）/cdp-probe.mjs/standalone-server.mjs；gomoku 改枚举三文件 | 0.5h |
| P2-6 | 死代码清扫 | preload.js:14 onGameFocus、game-card.js:22-32 悬停武装、doneHoldMs 死配置、main.cjs:221 词宝谜航注释、chess/index.mjs:123-127 冗余 pickQuipKey | 1h |
| P2-7 | chess/engine.test.mjs:85-103 | 加 loadFEN 注入口，补升变/逼和/五十回合/三重复行为测试 | 3h |

## 6. 总评

这是一套**自愈能力和防御纪律明显高于平均水准**的代码库：Origin 闸、白名单清洗、代际校验、原子写、SSE 哨兵、undo-finally、perft 黄金值全部在岗，08-22 的历史修复无一回退。真正的病不在单点质量，而在**三 runtime（宿主/pet/standalone）并存下「单边修复未同步」的惯性**——7 条 🔴 里 3 条（死区 ReferenceError、import 覆盖、delete 404）都直接出自这个病根。P0 六条约 2 小时清完即止血；之后把「pet↔standalone 卫星窗块抽参数化 .cjs」+「test.cjs 一致性断言」列入下个迭代，可从结构上终结这类 bug 的再生产。
