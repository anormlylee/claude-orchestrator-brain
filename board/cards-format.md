# 卡片：命令、事件和生成的文件

每个项目在台账旁边（`<项目文档目录>/brain/`）有两份文件，只有本项目主脑写，随台账一起提交：

| 文件 | 是什么 | 谁写 |
|---|---|---|
| `events.jsonl` | 事件记录，一行一件事：建卡、派活、打回、完成、请用户…… 只追加，是唯一的事实来源 | 卡片命令 |
| `cards.json` | 由事件算出来的“现在”，看板读它 | 卡片命令每次执行后自动重新生成 |

**两份都不手改。**插件钩子会拦下对它们的直接编辑；手改的内容也会被下一条命令覆盖。设计见 `docs/design/2026-11-board.md`。

为什么不手写：手写快照时，进入本列的日期、完成日期、打回次数都要主脑记得改，历史在阶段关闭时随卡删掉，看板也看不到会话的真实状态。改成命令记事件后，这些都由程序算，规则由命令检查，违规的命令不生效、不留记录。

## 命令

```bash
python3 ~/.claude/bin/card <子命令> ...      # 安装脚本把 board/card.py 链到这里
python3 ~/.claude/bin/card --help
```

在项目仓库里任意目录执行，命令往上找 `docs/brain/` 或 `brain/`；不在项目里时用 `-p <看板登记的项目键>` 或 `--dir <台账目录>`。

| 子命令 | 作用 |
|---|---|
| `init --project --brain-name --brain-id` | 新项目建立卡片记录 |
| `import` | 把旧的手写 `cards.json` 导入成事件（迁移时用一次） |
| `new <编号> --title --kind --priority --now [--milestone] [--caused-by <编号>] [--frozen] [--detail]` | 建卡 |
| `dispatch <编号> --session <会话编号> [--now]` | 派活：移到进行中，记下会话 |
| `link <编号> --session <会话编号>` | 记下另一个相关会话，不换列 |
| `verify <编号> [--now]` | 分支回报完成，移到待验收 |
| `reject <编号> --reason` | 打回：打回次数加一，移回进行中，现状写成打回原因 |
| `done <编号> [--evidence <产物目录>] [--now]` | 合入：移到已完成，记下验证产物 |
| `ask <编号> --decide 或 --act --ask <动作>` | 球交给用户：拍板或动手 |
| `answer <编号> [--now]` | 用户答复了，球回到主脑 |
| `external <编号> --now` | 等外部 |
| `block <编号> --reason` / `unblock <编号>` | 卡住 / 解除 |
| `move <编号> <列>`、`edit <编号> ...` | 换列；改标题、类型、优先级、阶段目标标记、现状、详情 |
| `drop <编号> --reason` | 作废、重复：从看板拿掉，记录还在 |
| `stage --stage --goal` / `stage --clear` | 设阶段目标（用户确认过的） / 清空 |
| `brain --name --id`、`leftovers <件数>` | 换主脑、更新遗留小项件数 |
| `show`、`log [--days 7]`、`check` | 看当前卡片；按天列出事件（填周流水）；重新生成并检查 |

命令检查的规则：
- 编号不重复；操作的卡必须存在；
- 标题 20 字以内，`ask` 和现状 40 字以内，现状不能为空；
- 待办和进行中的卡必须有优先级（1 到 3）；
- 球在用户时必须有 `ask` 和拍板或动手；
- 项目没有阶段目标时，卡不能标为属于阶段目标；
- 只有缺陷卡能写返工来源。

时间取执行时刻；测试时可用环境变量 `CARD_NOW` 指定。

## 事件（`events.jsonl`）

每行一个 JSON 对象：`at`（带时区的时刻）、`op`（子命令名，导入的卡是 `import`，建项目是 `project`）、`card`（卡片编号，项目级事件没有），以及该命令的参数。重放全部事件就得到现在的卡片。

## 生成的卡片（`cards.json`）

顶层：

| 字段 | 含义 |
|---|---|
| `generatedBy` | 固定提示：由事件生成，不要手改 |
| `project`、`brain`、`leftovers` | 项目名、主脑会话 `{name, id}`、遗留小项件数 |
| `stage`、`stageGoal` | 当前阶段和阶段目标；没有为 `null` |
| `stats` | 信任指标：`week` 是近 7 天，`stage` 是本阶段（有阶段目标时）；各含 `done` 完成、`rejects` 打回、`rework` 返工、`dispatched` 派出件数和起算日期 `since` |
| `cards` | 卡片列表 |

上板的卡：所有没完成的；已完成的只留本阶段内完成的（没有阶段目标时留最近 14 天）。更早的从看板上下来，记录还在事件里。

每张卡：

| 字段 | 含义 |
|---|---|
| `id`、`title`、`kind` | 编号、标题、类型（功能、缺陷、调研、决策、事务） |
| `column` | `todo` 待办、`doing` 进行中、`verify` 待验收、`done` 已完成、`frozen` 冻结 |
| `priority`、`milestone` | 优先级 1 到 3 或 `null`；是否属于阶段目标 |
| `ball`、`ask`、`askKind` | 球在谁（`you` 用户、`external` 外部、`brain` 主脑）；要用户做的动作；`decide` 拍板或 `act` 动手 |
| `now`、`blocked` | 一句话现状；卡在哪件事上（不阻塞为空） |
| `since`、`doneAt` | 进入本列的日期、完成日期（自动算） |
| `rejects`、`causedBy` | 打回次数；返工来源（只有缺陷卡有） |
| `sessions`、`evidence` | 对应的会话编号；验证产物目录（相对仓库根目录或绝对路径） |
| `detail` | 主脑自用的详情，看板不显示 |

示例（`board/check-cards.py` 和用例都以它为准）：

```json
{
  "generatedBy": "card.py：由 events.jsonl 生成，不要手改",
  "project": "示例项目",
  "stage": "内测",
  "stageGoal": "测试环境跑通完整业务流程",
  "brain": { "name": "示例项目主脑", "id": "local_00000000-0000-0000-0000-000000000000" },
  "leftovers": 3,
  "stats": {
    "week": { "since": "2026-11-05", "done": 1, "rejects": 1, "rework": 1, "dispatched": 2 },
    "stage": { "since": "2026-11-08", "done": 1, "rejects": 1, "rework": 1, "dispatched": 2 }
  },
  "cards": [
    {
      "id": "D-1", "title": "选定支付渠道", "column": "todo", "kind": "决策",
      "priority": 1, "milestone": true, "ball": "you",
      "ask": "在三个渠道里选一个", "askKind": "decide",
      "now": "三个渠道的费率和接入周期已查清", "blocked": "",
      "since": "2026-11-10", "doneAt": null, "rejects": 0, "sessions": [],
      "detail": "需求：……；选项：1……2……3……；推荐：……；代价：……；能否撤回：……"
    },
    {
      "id": "F-3", "title": "下单流程", "column": "doing", "kind": "功能",
      "priority": 1, "milestone": true, "ball": "brain",
      "ask": "", "askKind": null,
      "now": "打回一次后重做，预计今天提交", "blocked": "",
      "since": "2026-11-11", "doneAt": null, "rejects": 1,
      "sessions": ["local_11111111-1111-1111-1111-111111111111"]
    },
    {
      "id": "F-1", "title": "测试环境部署", "column": "done", "kind": "事务",
      "priority": null, "milestone": true, "ball": "brain",
      "ask": "", "askKind": null,
      "now": "已部署并验收", "blocked": "",
      "since": "2026-11-08", "doneAt": "2026-11-09", "rejects": 0, "sessions": [],
      "evidence": ".local/evidence/F-1/"
    },
    {
      "id": "B-2", "title": "部署后首页白屏", "column": "doing", "kind": "缺陷",
      "priority": 1, "milestone": false, "ball": "brain",
      "ask": "", "askKind": null,
      "now": "已定位到缓存配置，修复中", "blocked": "",
      "since": "2026-11-11", "doneAt": null, "rejects": 0, "sessions": [], "causedBy": "F-1"
    }
  ]
}
```

## 会话实况和“带去主脑”

两份本机文件，不进任何仓库：

- `~/.claude/board/live/<会话编号>.json`：每个会话由插件钩子 `board/live.sh` 写下自己的状态（`running` 在跑、`waiting` 等用户批准、`idle` 这一轮结束、`error` 出错中断），会话结束时删掉。看板据此在卡片上显示“会话在跑 / 等你批准 / 停了几小时”，并把等批准的会话放进第一屏队列。
- `~/.claude/board/pending/<主脑会话编号>.json`：看板上点“带去主脑”时留下的卡片内容。主脑会话里的本插件每 2 秒看一次，读到就填进输入框并删掉文件；10 分钟没被取走就作废（剪贴板里还有一份兜底）。
