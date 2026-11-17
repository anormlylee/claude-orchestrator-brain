# 卡片文件格式

项目看板读的数据。每个项目一份，放在台账旁边：`<项目文档目录>/brain/cards.json`。只有本项目主脑写它，随台账一起提交。设计见 `docs/design/2026-11-board.md`。

写完由 `board/check-cards.py` 检查。装了钩子后，主脑每次保存都会自动检查，不合格会被退回；手动检查：

```bash
python3 board/check-cards.py <项目文档目录>/brain/cards.json
```

## 顶层

| 字段 | 含义 | 写法 |
|---|---|---|
| `project` | 项目名 | 非空文字 |
| `stage` | 当前阶段 | 文字；没有写 `null` |
| `stageGoal` | 阶段目标，用户确认过的 | 文字；没有写 `null` |
| `brain` | 主脑会话 | `{"name": 会话名, "id": 会话编号}`，主脑开局登记自己时写入 |
| `leftovers` | 台账里遗留小项的件数 | 不小于 0 的整数 |
| `cards` | 卡片列表 | 没有卡片写 `[]` |

## 卡片

每个字段都要写，没有内容时空文字写 `""`，空值写 `null`。只有 `detail`、`rejects`、`causedBy` 可以不写。

| 字段 | 含义 | 写法 |
|---|---|---|
| `id` | 卡片编号 | 本文件内不重复，建议沿用台账编号 |
| `title` | 标题 | 业务语言，20 字以内 |
| `column` | 所在列 | `todo` 待办、`doing` 进行中、`verify` 待验收、`done` 已完成、`frozen` 冻结 |
| `kind` | 类型 | `功能`、`缺陷`、`调研`、`决策`、`事务` |
| `priority` | 优先级 | `1` 到 `3`；待办、进行中必填，其他列可写 `null` |
| `milestone` | 属于阶段目标 | `true` 或 `false`；项目没有阶段目标时只能写 `false` |
| `ball` | 球在谁 | `you` 用户、`external` 外部、`brain` 主脑 |
| `ask` | 要用户做什么 | 一个动作，动词开头，40 字以内；球在用户时必填 |
| `askKind` | 拍板还是动手 | `decide` 拍板、`act` 动手；球在用户时必填，否则写 `null` |
| `now` | 现状 | 一句话，40 字以内，不能为空 |
| `blocked` | 卡在哪件事上 | 文字；不阻塞写 `""` |
| `since` | 进入本列的日期 | `YYYY-MM-DD`，每次换列时更新，不能晚于今天 |
| `doneAt` | 完成日期 | 进已完成列时写 `YYYY-MM-DD`；其他列写 `null` |
| `detail` | 详情（看板不显示） | 可选。拍板类的完整决策栏；主脑自用的分支、提交、验收要点 |
| `rejects` | 验收打回次数 | 可选，不小于 0 的整数；主脑每打回一次加一，没打回过可以不写 |
| `causedBy` | 返工来源 | 可选，只用于缺陷卡：合入后才发现的问题，写引入它的那张卡的编号；不是返工就不写 |

已完成的卡保留到阶段目标关闭，用来算进度；阶段关闭后由主脑删掉，历史看周流水。

看板用 `rejects` 和 `causedBy` 算本阶段的两个信任指标：验收打回次数对已完成件数，以及合入后才发现的返工件数。删卡之前，主脑把这两个数记进周流水。设计见 `docs/design/2026-11-trust.md`。

## 示例

```json
{
  "project": "示例项目",
  "stage": "内测",
  "stageGoal": "测试环境跑通完整业务流程",
  "brain": { "name": "示例项目主脑", "id": "local_00000000-0000-0000-0000-000000000000" },
  "leftovers": 3,
  "cards": [
    {
      "id": "D-1", "title": "选定支付渠道", "column": "todo", "kind": "决策",
      "priority": 1, "milestone": true, "ball": "you",
      "ask": "在三个渠道里选一个", "askKind": "decide",
      "now": "三个渠道的费率和接入周期已查清", "blocked": "",
      "since": "2026-11-10", "doneAt": null,
      "detail": "需求：……；选项：1……2……3……；推荐：……；代价：……；能否撤回：……"
    },
    {
      "id": "F-3", "title": "下单流程", "column": "doing", "kind": "功能",
      "priority": 1, "milestone": true, "ball": "brain",
      "ask": "", "askKind": null,
      "now": "打回一次后重做，预计今天提交", "blocked": "",
      "since": "2026-11-11", "doneAt": null, "rejects": 1
    },
    {
      "id": "F-1", "title": "测试环境部署", "column": "done", "kind": "事务",
      "priority": null, "milestone": true, "ball": "brain",
      "ask": "", "askKind": null,
      "now": "已部署并验收", "blocked": "",
      "since": "2026-11-08", "doneAt": "2026-11-09"
    },
    {
      "id": "B-2", "title": "部署后首页白屏", "column": "doing", "kind": "缺陷",
      "priority": 1, "milestone": false, "ball": "brain",
      "ask": "", "askKind": null,
      "now": "已定位到缓存配置，修复中", "blocked": "",
      "since": "2026-11-11", "doneAt": null, "causedBy": "F-1"
    }
  ]
}
```
