# 1.2.2 维护审查（2026-10-22）

基线：`v1.2.1` / `f434346e13a42a2d1e9f063c1e837f577f268997`。这次维护在独立工作副本、独立 DSH_HOME 和测试端口完成，不更新使用中的 DSH 实例。

## 已修复

| 范围 | 触发与结果 | 修复及验证 |
| --- | --- | --- |
| 宿主鉴权 | 自定义 `/live2d/*` 路由未继承 DSH 登录保护 | 全部路由调用宿主 `connection.requestRejection`；匿名读写/SSE 拒绝，已登录正常工作 |
| Electron 登录 | 加入鉴权后独立浏览器 cookie 与 Node HTTP 心跳不共享 | 主进程用 Electron session.fetch 建立会话并检查健康；真实 Electron 43.8.3 虚拟显示器检查通过 |
| 文件访问 | 只检查叶子文件，目录软链接可绕过路径前缀 | 检查实际路径或所有祖先；导入/绑定/删除/读取都拒绝越界 |
| 模型管理 | 嵌套模型可列出但无法绑定/删除；删除当前模型留下旧引用 | 嵌套目录精确操作且保留兄弟目录；刷新选中模型与独立版角色；并发非覆盖导入使用排他创建 |
| 请求边界 | JSON `null`/数组引发异常；跨端口 cookie 无法仅靠 SameSite 隔离 | 宿主校验 JSON 对象与 UTF-8 字节上限；独立版增加 Host/Origin 检查；上传拒绝可执行文件 |
| 游戏 agent | 工具限制出错后继续运行；范围内工具不受全局过滤限制 | 空全局 allow-list 加单调拒绝执行 guard；设置失败拒绝开局；卸载期间创建完成的句柄立即释放 |
| 模式配置 | 改显示模式时可能删掉相邻 patch 和嵌套的同名字段 | 只改目标 config 的直接子键；识别实际缩进；不支持的结构拒绝改写 |
| 角色与日记 | 切角色后旧聊天、迟到回复或旧自动保存设置污染新档案 | 按 profileId 保存前端记录，异步工作绑定原档案；持久化更新串行化并复核活动档案 |
| 独立版生命周期 | 待回复 HTTP 请求阻塞 server.close；同分钟重启覆盖日记 | 先取消任务再关服务；日记文件名带随机后缀；并发记忆写入保留全部条目 |
| 模型切换 | A → B 加载中再选 A，迟到的 B 仍然覆盖选择 | 所有有效选择均更新请求序号，同路径 SSE 也取消旧加载 |
| 游戏前端 | 远端忙碌状态停止后续轮询、60 秒超时早于服务端预算，旧响应可覆盖新棋局 | 只在本地请求期间暂停轮询；按后端预算设置超时，切换时取消并隔离过期响应 |
| 桌宠重试 | loadURL 拒绝和 did-fail-load 双重计时重试 | 单一重试计时器、禁止并发加载、窗口关闭释放轮询 |

## GitHub 积压

审查了仓库全部 7 个 PR 与 1 个普通 issue；#1–5 已合并。原仓库没有 Releases 和 Actions 运行历史。

- [PR #8](https://github.com/Tisitan/dsh-live2d-companion/pull/8)：纳入 Desktop 结构化索引注入修复，保留 HTTP 路径，并验证序列化、去重、widget 开关及真实宿主索引方法。感谢 CiasaSavage。
- [Issue #7](https://github.com/Tisitan/dsh-live2d-companion/issues/7)：注入缺口已修，但没有可运行的原生 DSH Desktop 壳验证它的资源代理认证，不能据索引测试直接关闭此 issue。
- [PR #6](https://github.com/Tisitan/dsh-live2d-companion/pull/6)：有合并冲突；滚动日记计数重置仍可能重复拾取旧角色聊天，保存链路缺 profileId 绑定。本次先修复主线串档问题，未原样合并该功能 PR，也未关闭或代作者提交评审。

## 验证与边界

- `npm test`：棋类引擎、LLM 走法协议、PID 生命周期、鼠标穿透状态机、宿主 HTTP/模式配置、认证、独立版 smoke/角色切换/关闭、桌宠重试。
- DSH `0.2.1-rc.2` / Node `24.21.0`：在独立实例实测登录、60 项 HTTP/SSE/模型/台词/离线游戏检查；事件由测试会话生成，无正式会话数据。
- 在线游戏集成：本机确定性模型服务验证解说、阿尔法狗非法落子重试、角色作用域工具与 PTC `run_code` 调用均被拒绝（实际执行次数 0）；未调用外部模型服务。
- Electron `43.8.3`：临时 Xvfb 下真实 cookie 交换、健康检查、保护资源、SSE、旧 token 下 cookie 复用及隐藏 renderer 启动通过。未触碰实际桌面。
- Electron 与 standalone 两份锁文件 `npm audit --package-lock-only`：0 个已知漏洞。保留受支持的 43 主版本，升级至 43.8.3；间接依赖包含 undici 7.30.1。
- 打包检查包含新增运行时模块，不包含用户模型、Cubism Core、node_modules 或凭据。
- 新增 CI：Linux Node 22/24、Windows Node 24，测试、语法、打包和审计。

尚需实机确认：原生 DSH Desktop 的代理认证、Windows/macOS 窗口焦点与 DPI、真实 Live2D 模型渲染/动作/鼠标穿透。当前环境没有模型和 Cubism Core，不以空画布启动代替模型验收。既有 Node 18 宿主声明保留；Electron 安装工具链需要 Node 22.12 或更新。

依赖依据：[Electron 支持策略](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)、[Electron 安全公告](https://github.com/electron/electron/security/advisories/GHSA-qmv3-fv6v-rmhq)、[session.fetch 文档](https://www.electronjs.org/docs/latest/api/session#sesfetchinput-init)。审计是已知漏洞数据库检查，不表示不存在未知问题。
