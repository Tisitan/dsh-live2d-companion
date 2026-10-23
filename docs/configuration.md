# 配置、台词与模型绑定

[返回首页](../README.md) · [开发与调试](development.md) · [独立版说明](../standalone/README.md)

本文以 DSH 插件模式为主。独立版复用前端台词与模型绑定，但启动配置、连接设置和数据目录以独立版说明为准。

## DSH patch 配置

插件默认开启网页挂件、关闭桌宠。安装后，在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 使用相同 `id` 覆盖配置。已有条目时编辑原项，避免重复 id；面板的显示模式切换需要此文件中存在唯一的 `live2d-companion` 条目：

```yaml
- insert:
    - id: live2d-companion
      name: dsh-live2d-companion
      config:
        model: 'MyModel/MyModel.model3.json'
        widget: false
        pet: true
```

`model` 使用 `/` 分隔，路径相对插件的 `public/model/`；上例需要自行放入对应模型及其依赖文件。DSH 热重载 patch 后，桌宠生命周期配置随之更新；网页是否注入挂件需刷新页面才能反映。

| 键 | 默认值 | 说明 |
|---|---|---|
| `model` | `nori/ARGNori.model3.json` | 默认模型路径。此路径是代码默认值，仓库不包含该模型 |
| `widget` | `true` | 是否向 DSH 网页和 Desktop 首页注入挂件 |
| `pet` | `false` | 是否由 DSH 启动和管理 Electron 桌宠；需先安装 `pet/` 依赖 |
| `petDir` | 插件内 `pet/` 的绝对路径 | Electron 壳目录；自定义时建议填写绝对路径 |

默认值见 [index.js](../index.js)，bundle 注册行见 [cordis.patch.yml](../cordis.patch.yml)。

模型面板的选择保存在插件根目录 `model-selection.json`，优先于 patch 的 `model`；“恢复默认”清除此选择。页面 URL 的 `?model=MyModel/MyModel.model3.json` 可用于加载时临时指定模型，不修改持久化选择。打开中的普通页面仍会接收宿主模型切换广播，不能把 URL 参数当作永久锁定。

所有 `/live2d/*` 路由使用 DSH 登录与 Host/Origin 校验。配置、导入、绑定、删除和对局等写入操作另要求本机来源；浏览器请求必须满足同源校验。远程登录能够读取页面，不代表可以远程写入模型或配置。

## 台词与行为参数

台词由默认文件和用户预设合成。面板编辑器不改写官方默认文件，用户文件被 Git 忽略；升级或重新安装前仍应备份个人配置和模型。

| 文件 | 用途 |
|---|---|
| [public/quips.json](../public/quips.json) | 随版本提供的默认 `pools`、`rotation`、`behavior` |
| `public/quips.local.json` | 生效预设指针，例如 `{ "active": "my-lines" }` |
| `public/quips-presets/my-lines.json` | 用户预设，可包含台词池和行为参数 |

加载顺序为内置保底值 → 官方默认 → 生效预设。`pools` 按整个池覆盖，不逐条拼接；预设中没有的池继续使用默认值。`rotation`、`behavior` 按字段合并。

例如，只覆盖完成台词和完成气泡时间的预设：

```json
{
  "rotation": { "doneHoldMs": 5000 },
  "pools": {
    "done": ["这轮完成了。", "已经处理好啦。"]
  }
}
```

选择“词”按钮打开编辑器，按每行一句编辑；保存或切换预设后，当前页面立即重载台词。其他已打开页面会在可见时按约 30 秒的间隔重新读取。手动修改文件也通过此轮询生效。

编辑器的“保存”和“另存为”会保存当前各池的完整快照，因此这些已保存的池不会自动采用上游新台词。“恢复默认”从预设中移除所选池，让它重新使用默认内容；后续全量保存可能再次将其写入快照。节奏和阈值没有独立的可视化表单，可直接编辑预设 JSON；面板保存会保留预设已有的这些字段。

| 参数 | 默认值（毫秒） | 生效方式 |
|---|---:|---|
| `rotation.holdMs` | 6000 | 普通状态台词停留时间 |
| `rotation.intervalMs` | 9000 | 状态台词轮换间隔；进入状态时创建计时器，修改后下次进入状态采用新间隔 |
| `rotation.doneHoldMs` | 6500 | 完成通知停留时间，独立于完成状态的 6 秒回落计时 |
| `behavior.sleepAfterMs` | 300000 | 空闲多久后可进入睡眠；前端每 30 秒检查一次，不是精确到毫秒触发 |
| `behavior.seriousAfterMs` | 45000 | 连续工作超过阈值后，在台词轮播时使用严肃表情 |
| `behavior.overtimeAfterMs` | 120000 | 连续工作超过阈值后，在台词轮播时使用困扰表情与 `overtime` 池 |

写接口接受有限数字，范围为 0–3600000 毫秒。台词池须保留至少一句；写接口限制每池 1–200 句，每句 1–300 字符。显示气泡会归一化空白，并把超过 180 字符的文本截短。相关实现见 [config.js](../public/src/config.js)、[state.js](../public/src/state.js) 和 [ui.js](../public/src/ui.js)。

| 池 | 使用场景 |
|---|---|
| `thinking`、`working`、`waiting`、`error`、`sleeping` | 相应状态的首句与轮播 |
| `done` | 单次任务完成通知 |
| `overtime` | 连续工作超时后的轮播 |
| `click`、`pat`、`drag` | 点击、摸头、拖动反馈 |
| `busy` | 忙碌时点击或双击的反馈 |
| `greet`、`greet_morning`、`greet_night` | 启动问候；5–11 时用早晨池，23–5 时用深夜池 |
| `idle` | 空闲随机台词；每两分钟检查，另有气泡静默期与概率条件 |

气泡优先级为 0（状态轮播、普通扩展气泡）、1（对局解说/思考）、2（物理互动、完成、报错、操作反馈）。低优先级不能覆盖正在显示的高优先级气泡；同级新消息覆盖旧消息，没有排队逐条播放。网页挂件中气泡会避让状态灯与任务灯；长气泡可能覆盖部分模型身体。

## 模型资源与自动嗅探

模型及全部相对引用资源应一起放入，例如：

```text
public/model/MyModel/
├── MyModel.model3.json
├── MyModel.moc3
├── textures/
├── motions/
├── expressions/
└── profile.json          # 可选，绑定档案
```

插件使用 Cubism 4/5 模型的 `.model3.json` 清单，具体兼容性取决于模型、Cubism Core 与渲染库的组合。模型和 Core 均需自行准备并遵守原许可。官方 Haru/Hiyori 已用于真实加载验证，不代表所有模型都具备同样的情绪素材。

[binding.js](../public/src/binding.js) 从 `FileReferences` 读取素材，按以下顺序解析：

1. `profile.json` 指定的表情名或动作引用确实存在时，采用精确绑定。
2. 未得到有效绑定时，按关键词嗅探：表情匹配 `Expressions[].Name`，动作匹配动作文件名；按清单顺序选第一个匹配项。
3. `default` 表情未匹配时使用第一张表情；`think` 动作未匹配时尝试名称含 `pose` 的动作组。其余缺失槽位不播放相应表现。

示例关键词包括表情的 `shy`/`blush`/`害羞`、`happy`/`smile`/`开心`，动作的 `nod`、`sleep`、`think`。Live2D 不规定这些语义命名，只有 `F01`、`F02` 等素材名的模型通常需要手工绑定。

点击反应优先使用 `profile.motions.clickPool`；否则从第一个名称含 `Tap`、`Reaction` 或 `Touch` 的动作组取素材，并排除文件名含 `angry` 的动作。清单里的空 `clickPool` 会继续使用自动嗅探，不能用空数组表达“禁用自动点击池”。

当绑定的睡眠动作位于运行时待机组、且该组至少有两个动作时，渲染层筛选该组的随机播放：睡眠状态使用睡眠动作，清醒状态排除它。通常对应模型的 `Idle` 组；其他分组或素材条件继续使用运行时原有行为。显式按组和序号播放不受随机池筛选影响。

## 精确绑定与预览

`profile.json` 与选中的 `.model3.json` 放在同一目录，支持嵌套模型目录。只有有效引用覆盖自动嗅探，错误或缺少的引用会继续尝试嗅探。

| 表情槽位 | 用途 |
|---|---|
| `default` / `happy` / `excited` | 空闲 / 完成 / 工作 |
| `shy` | 摸头、拖动 |
| `doubt` | 思考和等待确认，共享槽位 |
| `troubled` / `serious` | 报错或加班焦虑 / 加班严肃 |
| `surprised` | 从睡眠唤醒时的过渡 |
| `dark` / `sleep` | 离线 / 睡眠 |

| 动作槽位 | 用途 |
|---|---|
| `think` / `excited` / `shake` | 思考 / 工作 / 等待确认 |
| `dizzy` / `nod` | 报错 / 完成 |
| `sleep` / `glitch` | 睡眠 / 报错时的可选特效 |
| `clickPool` | 点击随机动作列表 |

表情值是素材名；单个动作值为 `[组名, 从 0 开始的序号]`。下面的名字仅为示例，需替换为模型实际内容：

```json
{
  "expressions": {
    "default": "Default",
    "happy": "Smile",
    "doubt": "Doubt",
    "sleep": "Sleep"
  },
  "motions": {
    "think": ["Poses", 1],
    "nod": ["Reactions", 0],
    "sleep": ["Idle", 1],
    "clickPool": [["Reactions", 0], ["Reactions", 2]]
  }
}
```

可视化操作：模型面板 → “查看” → 选择状态 → “绑定” → 点击素材试穿 → “保存绑定”。试穿只改预览和草稿，保存才写入 `profile.json` 并使当前模型热更新。“恢复自动嗅探”删除该档案。预览是独立实例，不订阅 SSE、不装配普通互动，状态保持在手动选择的值。

思考与等待共用 `doubt` 表情，修改一个会影响另一个；空闲与离线没有动作槽。绑定编辑器会提示这些映射关系。解析结果可在页面控制台查看 `window.__l2d.binding`。

## 状态与表现映射

表中的名称是语义槽位，实际表情与动作取决于上述绑定。

| 状态 | 典型触发 | 表情 / 动作 | 台词与回落 |
|---|---|---|---|
| `idle` | 初始、完成回落、唤醒 | `default` / 无显式动作 | 偶发 `idle` 台词 |
| `thinking` | `turn/start`、非忙碌时的 `assistant/chunk` | `doubt` / `think` | `thinking` 轮播 |
| `working` | `tool/call`、工作流或子代理开始、确认通过 | `excited` / `excited` | `working` 轮播，动作约每 22 秒重放 |
| `waiting` | `approval/asked` | `doubt` / `shake` | `waiting` 轮播，动作约每 16 秒重放 |
| `error` | `llm/retry-started` | `troubled` / `dizzy`，有绑定时可能选 `glitch` | `error`；约 4.5 秒回 `thinking` |
| `done` | `turn/end` 或完成快照 | `happy` / `nod` | 单次 `done` 通知；状态约 6 秒回 `idle` |
| `sleeping` | 前端空闲超时 | `sleep` / `sleep` | `sleeping` 轮播；互动可唤醒 |
| `offline` | SSE 连接报错 | `dark` / 无显式动作 | 等待重连快照 |

工作超时的严肃/困扰表情是 `working` 内部升级，不增加第九种状态。页面隐藏时跳过轮播与周期动作；预览模式不执行工作超时升级、睡眠检查和瞬态自动回落。

多个会话同时存在时，主灯由宿主按 `working > waiting > thinking > error > done > idle` 聚合。每会话另显示任务灯，最多 8 个，更多用数量折叠；仅一个会话时不重复显示任务灯。某个任务结束会单独发出带任务号的完成气泡，其他任务仍可让主灯保持工作状态。

客户端会去重已观察到的完成事件和重连快照；同一任务号出现新的活动事件，或明确的空闲→完成快照转换后，可以再次通知。当前协议没有独立的完成事件 ID，不能保证补播整轮断线期间发生的所有完成事件。
