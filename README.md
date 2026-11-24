# claude-orchestrator-brain

让一个 [Claude Code](https://docs.claude.com/en/docs/claude-code) 会话当「主脑」，调度同一项目里多个并行开发的会话。

> 非官方项目，与 Anthropic 无关联。

同一个项目里同时跑多个 Claude Code 会话时，指定其中一个会话当主脑，其他会话都是分支会话。主脑只做五件事：**派活、独立验收、技术裁决、合入、记账**，自己不写实现代码，也不展开设计讨论。技术问题靠证据由主脑裁决，只有价值取舍才交给用户。

适合这样的工作方式：一个项目同时有好几条功能或修复分支在飞，每条分支交给一个独立会话去做，你只和主脑对话。另外还可以随手开讨论会话，把有价值的结论交回主脑。

## 解决的问题

| 没有主脑时 | brain 的做法 |
|---|---|
| 分支说"测过了"就合 | 自报不算验收。主脑核对 tip，跑全量加集成测试，并自己选变异探针（必须变红）。 |
| 主线状态只在聊天记录里，会话一压缩就丢 | 台账提交进仓库，任何新会话读台账就能接着干。 |
| 台账越写越长，变成流水账 | 台账只反映"现在"，用增删改的方式维护；流水按周归档；交接页每周整篇覆盖。 |
| 项目一多，每次看都陷进混乱的信息池 | 看板第一屏是一张项目清单，分三级：每个项目一行，写要你做的事各几件；有事要你批准或拍板的项目自动展开前 3 件，其余收起；点进去才是分列看板。项目位置固定，不按紧急程度重排。点“带去主脑”会跳到该项目的主脑会话，卡片内容自动填进输入框，补一句指示就能发。 |
| 卡片靠主脑手写，日期、次数常漏改，历史随卡删掉 | 主脑用卡片命令记事件（建卡、派活、打回、合入……），卡片文件由事件生成；规则由命令检查，违规不生效；历史永久保留，周流水可以直接生成。 |
| 某个分支会话弹出权限确认、停在那里半天没人发现 | 每个会话由钩子写下自己的实况（在跑、等你批准、停了），看板当场标红，所在项目在第一屏自动展开。 |
| 你不读代码，只能凭主脑一句“已验证通过”相信结果 | 回报必须附验证产物（录屏、截图、复现命令），主脑亲手重跑；合入时把产物交给你看。看板显示近 7 天和本阶段的完成、打回、返工件数，说明质量走向。 |
| 派活提示每次临时写，容易漏项 | 固定的派活模板和回报格式，所有槽位必填。 |
| 分支会话假借用户授权，让主脑代做它被拒绝的操作 | 视为权限洗白，拒绝并报告用户。 |
| 会话越跑越长，主脑忘了自己的角色 | output style 常驻系统提示，压缩后也不会丢。 |
| 讨论会话的结论散落在各处，或者没经确认就被当成定案 | `/brain-handback` 分类、写成文档再交回；口头决定要回主脑确认后才生效。 |
| 你不在时，某个子代理一条 `pkill -f "cat"` 关掉了整台 Mac 的应用 | 派活模板写明禁止按模式杀进程；可选的 `guard/` hook 在执行层面拦截，子代理也绕不过。 |
| 回报又长又含糊，猜测写得像事实，要你拍板的事埋在中间 | 回报先写待决定和出入，再给证据；每条论断标「实测 / 推断 / 未核实」；待决项写全推荐、代价、能否撤回、阻塞什么。可选的 `report-check/` hook 在发送时检查，不合格退回重写。 |

## 文件

仓库根目录就是一个插件：技能、看板、钩子一起装、一起升级。

```
.claude-plugin/          插件与插件市场清单
skills/brain/
  SKILL.md               主流程：开局、台账、派活、接收交回、验收、合入、周切换、红线
  dispatch-template.md   派活提示模板 + 分支回报格式
  ledger-template.md     cards / ledger / decisions / 周流水 / handoff / inbox 模板
skills/brain-handback/
  SKILL.md               讨论会话把结论分类、写成文档、交回主脑
output-styles/brain.md   主脑角色约束（常驻系统提示；插件里的 output style 会带前缀，所以由 install.sh 单独装）
hooks/
  hooks.json             插件的钩子配置：看板模组、守卫、回报检查、卡片文件守护、会话实况
  register.tsx           项目看板（输入 /board 打开）；也负责把“带去主脑”的内容填进主脑会话的输入框
types/index.d.ts         看板的状态声明
tests/board.test.tsx     看板用例（claude plugin test .）
guard/
  block-broad-kill.py    杀进程守卫：拦 pkill -f、killall
  redline.py             红线守卫：拦强制推送主分支；拦对本机登记的生产环境做写操作（只读不拦）
  test_*.py              用例
report-check/
  check-report.py        分支回报格式检查（发 SendMessage 前）
  banned-phrases.txt     禁用的含糊说法，按团队习惯增删
  test_check_report.py   用例
board/
  card.py                卡片命令：记事件、生成卡片文件（安装后在 ~/.claude/bin/card）
  cards-format.md        卡片命令、事件和生成文件的说明
  check-cards.py         卡片格式检查；作为钩子时拦下对卡片文件的手改
  live.sh                会话实况钩子：每个会话写下自己在跑、等批准还是停了
  test_card.py、test_check_cards.py  用例
scripts/
  hook-run.py            钩子统一记录：拦截和出错写进 ~/.claude/logs/hooks.log，闸坏了能被发现
  test_hook_run.py       用例
install.sh               本机安装（见下）
notify/                  可选，不在插件里：派活卡片通知（仅 macOS 桌面 App，./install.sh --notify）
docs/                    诊断、设计文档
```

本机私有数据不进仓库：看板登记表 `~/.claude/board/projects.json`，生产环境清单 `~/.claude/redlines.json`（红线守卫据此判断哪些主机是生产），会话实况 `~/.claude/board/live/` 和“带去主脑”的待填内容 `~/.claude/board/pending/`。

## 安装

**方式一：插件市场（只用不改）**

在 Claude Code 里执行：

```
/plugin marketplace add Anormallylee/claude-orchestrator-brain
/plugin install orchestrator@claude-orchestrator-brain
```

output style 需要另外装一次：

```bash
git clone https://github.com/Anormallylee/claude-orchestrator-brain.git
cd claude-orchestrator-brain
./install.sh --styles-only
```

**方式二：本机目录（要改的人）**

```bash
git clone https://github.com/Anormallylee/claude-orchestrator-brain.git
cd claude-orchestrator-brain
./install.sh
```

把仓库目录加进 `~/.claude/settings.json` 的 `env.CLAUDE_CODE_PLUGIN_DIRS`，装 output style，建两份私有数据文件，并清掉旧版逐个软链接、逐条挂钩子留下的东西。在仓库里改文件，新开的会话就用上新版本。卸载：`./install.sh --uninstall`。

两种方式只选一种。命令名都是 `/brain`、`/brain-handback`、`/board`（技能用 `name` 字段保留了不带前缀的命令名）。

## 使用

**主脑**：在项目里新开一个会话，输入 `/brain`。

主脑会先切到 `brain` output style，然后找台账，并把自己登记为「当前主脑会话」。第一次在某个项目里用时，它会问你几项规则参数：
- WIP 上限
- 合入权限
- 测试口径

问完后建立 `brain/` 目录，下面有：
- `ledger.md`：当前状态
- `decisions.md`：仍然有效的决定
- `handoff.md`：交接页
- `log/<周>.md`：本周流水
- `inbox/`：讨论会话交回的文档

**讨论会话**：在项目里随手开一个会话讨论问题。讨论出值得交给主脑的结论时，输入 `/brain-handback`。它会：
- 先把结论分成三类给你过目：不交回 / 待拍板 / 缺陷或缺口；
- 你确认后写成文档并提交；
- 从台账找到当前主脑，把回报发过去。

你在讨论会话里口头定下的事，会作为"待确认"交回。主脑会再问你一句，你确认后才生效，避免转述走样。讨论会话不改代码，要改的交给主脑派活。

**建议按周轮换主脑会话。** 周末让主脑收尾，它会整理台账并覆盖 `handoff.md`。下周开新会话，粘贴 `handoff.md` 末尾的开场白即可。

## 可选：派活卡片通知（仅 macOS 桌面 App）

主脑派活时，有些情况会生成一张**需要你点一下才会启动**的卡片。卡片不会触发系统通知，你切到别的 App 时很容易漏看，分支就一直卡着没开工。会出卡片的情况：

| 桌面 App 版本 | 什么时候出卡片 | 何时提醒 |
|---|---|---|
| 新版（派活工具 `start_session`） | 主脑被分支回报自动唤醒的那一轮，应用不让直接启动会话，主脑只能用 `own_initiative` 提一张卡片 | 卡片生成后 |
| 新版 | 用 `offer` 方式派活，调用会停住，等你选"新开会话 / 在这里做" | 调用开始时 |
| 旧版（派活工具 `spawn_task`） | 每次派活 | 卡片生成后 |

`user_asked` 派活会直接启动会话，不提醒。

`notify/` 用一个 hook 补上这个提醒：弹一条 macOS 通知，标题写着分支名，**点通知会切回 Claude**。

```bash
./notify/install.sh                    # 安装（新旧版 App 通用，重复执行结果一致）
./notify/install.sh --uninstall        # 卸载
```

从旧版升级上来的：桌面 App 升级后旧 hook 只挂在 `spawn_task` 上，不会再触发。重新执行一次 `./notify/install.sh`，它会把旧条目替换成新的。

**为什么不打包进 plugin**：plugin 会装到所有环境，而这个问题只在 macOS 桌面 App 上存在。命令行和 IDE 里没有这两个派活工具，hook 不会触发；Windows 桌面 App 有，但跑不了 bash 和 osascript。另外，通知会改变系统行为（首次会弹授权），应当由用户显式选择。所以保持为可选组件。

安装脚本会：
- 用系统自带的 `osacompile` 编译一个不占 Dock 的小 App `ClaudeNotify.app`，放在 `~/.claude/hooks/notify/` 下；
- 把 hook 脚本软链接到同一目录；
- 往 `~/.claude/settings.json` 合并 `PreToolUse` 和 `PostToolUse` 各一条 hook（matcher 为 `mcp__ccd_session__start_session|mcp__ccd_session__spawn_task`），先删掉本组件以前写的条目再追加，改动前会先备份。是否弹通知由脚本按派活方式判断。

装完需要你做两件事：
1. 系统询问「ClaudeNotify 想要发送通知」时点**允许**。
2. 在「系统设置 → 通知 → ClaudeNotify」里把样式改成**提醒**。横幅几秒就消失，人不在电脑前等于没通知。

已经开着的主脑会话要重启才会加载 hook。每次提醒会在 `~/.claude/hooks/notify/spawn-task.log` 记一行，没收到通知时可以先查这里。

**为什么不直接用 `osascript`**：命令行里执行 `display notification`，通知会记在「脚本编辑器」名下，点击只会打开脚本编辑器，没法指定点击后去哪。按 Apple 的 [Mac Automation Scripting Guide](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html)，把脚本编译成独立 App 后，通知就记在这个 App 名下，点击通知会重新打开它并再次执行 `run`。`ClaudeNotify` 利用这一点：被 hook 调起时发通知，被点击打开时把 Claude 切到前台。这样不用装 `terminal-notifier` 之类的第三方工具。

**限制**：仅 macOS 桌面 App（hook 脚本在其他平台会静默跳过）；Windows 桌面 App 需要另写 PowerShell 版本，欢迎 PR。点通知只会把 Claude 切到前台，不会精确跳到发出卡片的那个会话。依赖 `jq`（`brew install jq`）。

## 守卫：杀进程与红线

并行开的会话越多，你不盯着的子代理越多。真实发生过的一次：某个子代理想结束一个卡住的 `cat`，执行了

```bash
pkill -f "cat" -n
```

`-f` 拿整条命令行做正则匹配，而 `/Applications` 里就有 `cat`（Appli**cat**ions），于是 `/Applications` 和 `/System/Applications` 下几乎所有应用、连同通知中心一起收到 SIGTERM。写在后面的 `-n`（只杀最新一个）也没生效：macOS 自带的 BSD pkill 遇到第一个非选项参数就停止解析选项。

派活模板里已经写了这条红线，但提示词防不住子代理自己临时写的命令。`guard/` 用一个 PreToolUse hook 在执行前拦截：

| 拦截 | 放行 |
|---|---|
| 任何 `killall` | `kill <PID>` |
| `pkill -f`、`-9f` 等合写、`--full` | 不带 `-f` 的 `pkill 进程名` |
| `kill $(pgrep -f …)`、`` kill `pgrep -f …` ``、`pgrep -f … \| xargs kill` | 单独的 `pgrep -fl …` |

前面加 `sudo`、`env`、变量赋值、绝对路径，或者用 `;` `&&` `|` 串在别的命令后面，都照样拦。被拦时 hook 会把原因和替代做法返回给模型（先 `pgrep -fl` 确认 PID 再 `kill <PID>`），会话不会卡住。

```bash
python3 guard/test_block_broad_kill.py # 跑用例
```

随插件安装，默认开启。它会全局禁掉 `killall` 这类命令，影响所有项目；工作流里有合理用法（比如 `killall Dock`）的，在插件设置里把「杀进程守卫」关掉。

**红线守卫**（`guard/redline.py`，同样随插件安装）：强制推送到 main / master 一律拦；对 `~/.claude/redlines.json` 里登记的生产主机做写操作（上传文件、重启服务、改库等）时拦下，要用户在对话里同意后，命令说明写明“已在对话中同意”才放行。只读操作不拦。清单为空时只管强制推送。

**限制**：
- 按文本规则匹配，防的是随手写出的危险命令，不防刻意绕过（例如 `python -c` 里调 `os.system`）。
- 命令里带引号的字符串也会被检查，所以提交说明里恰好写着 `killall xxx` 也会被拦。这是有意的：否则 `bash -c "killall …"` 就能套一层绕过。
- 只管 Claude Code 自己执行的命令，管不到其他 AI 工具和你在终端里敲的命令。
- 依赖 `python3` 和 `jq`。macOS 上没装命令行开发者工具时，`python3` 只是占位程序，安装脚本会检测并拒绝安装，避免装上一个静默失效的 hook。

## 回报格式检查

分支会话用 `SendMessage` 发出第一行含「最终回报：」的消息时，这个 hook 先按派活模板「回报格式」检查一遍：
- 第一行写明完成 / 部分完成 / 卡住；
- 1–3 栏（需要决定、出入、遗留）都在，没内容写「无」；4–8 栏都在，或者合成一行「【4–8】不适用：<理由>」；
- 第 8 栏「验证产物」写了产物路径和复现命令；写不适用时必须有理由（只限项目还没有验证技能，或改动没有用户能看到的行为）；
- 需要决定的每一项都写了推荐、代价、能否撤回、阻塞什么和依据；出入的每一项都标了依据（实测 / 推断 / 未核实）；
- 没用 `banned-phrases.txt` 里的含糊说法（代码格式里的不算）。

不合格就拒绝发送，并把问题逐条返回给模型，模型改好后重发。别的消息一律放行，检查程序出错也放行。

```bash
python3 report-check/test_check_report.py     # 跑用例
```

随插件安装，默认开启。禁用说法清单是按中文团队的习惯写的，别的团队先改清单，或在插件设置里把「回报格式检查」关掉。

**限制**：只查格式，不查内容真假。模型完全可能在每栏里填上合规的空话，或者把推断标成实测；主脑验收时抽查实测项（见 `skills/brain/SKILL.md`「验收」）才是兜底。

## 看板与卡片

输入 `/board` 打开。第一屏是一张项目清单，分三级（注意力的单位是项目：同一项目的几件事一起处理，切换成本最低；项目多了也不会堆成一长串）：

1. **项目行**：每个项目一行，写阶段、要你做的事各几件（等你批准、待审、动手、待你看）、会话在跑或停滞。项目按登记顺序固定，不按紧急程度重排。没事的项目只剩一行。
2. **展开**：有会话等你批准或有待审的项目自动展开前 3 件，其余写“还有 N 件”；只有动手、待你看的项目默认收起。展开后：
   - 等你批准的会话（权限弹窗）：点“去这个会话”；
   - 待审、等你动手的卡：点“带去主脑”，跳到主脑会话，卡片内容自动填进输入框；
   - 待你看：主脑合入时明确请你看的交付（`card done --review`），点“看验证产物”，确认后点“看过了”就从首屏消失（只记在本机）；不满意点“带去主脑”。
3. **项目页**：分列看板，带阶段进度、会话实况、信任指标（近 7 天和本阶段的完成、打回、返工）。已完成列只先显示最近 5 件。

**决策卡的审批**：和常规办公审批一样分三种状态，卡片上各一个色块——**待审**（红）、**通过**（绿）、**否决**（灰）。主脑新建的决策卡默认待审；你在对话里定了，主脑用 `card approve <编号> --note <你的原话>` 记通过、`card veto <编号> --reason <原因>` 记否决，两者都把卡结案，记录永久保留。项目页顶上的“审批”一排按钮可以只看待审、通过或否决的卡，一眼看清哪些定了、哪些没定；通过、否决的卡过了已完成列的保留期也照样查得到。凡是要你审的事，看板和卡片命令里一律叫“待审”。

卡片由主脑用卡片命令维护（`python3 ~/.claude/bin/card --help`），命令写事件、生成卡片文件，详见 `board/cards-format.md`；设计见 `docs/design/2026-11-board.md`，验证产物与信任指标见 `docs/design/2026-11-trust.md`。

会话实况只在桌面 App 里有：钩子靠桌面 App 给每个会话设的会话编号认人。

## 兼容性

前提：**一个人在自己的环境里调度多个会话**。所有会话必须在同一台机器、同一个系统用户下，因为会话之间的消息走的是每个 Claude Code 进程在 `/tmp` 下开的本机 socket，不经过任何服务器。

| 环境 | 能否使用 | 自动化程度 | 验证状态 |
|---|---|---|---|
| 桌面 App（macOS）Code 标签页 | ✅ 完整可用 | 全自动：主脑自己开会话、收回报、归档、切 output style | 已实测 |
| 命令行版（macOS） | ✅ 可用 | 半自动：会话之间互发消息是自动的；开会话要手动；没有归档这一步；output style 写进设置文件 | 已实测：有 `SendMessage` / `ListAgents`，发出的消息能送到其他会话 |
| 命令行版（Linux） | 🟡 预计同 macOS 命令行版 | 同上 | 未实测，消息通道机制相同 |
| VS Code / JetBrains 插件 | 🟡 预计同命令行版 | 同上 | 未实测 |
| 桌面 App（Windows） | ❓ 未知 | — | 未实测 |
| 网页版 / 云端会话 | ❌ 不适合当分支会话 | — | 云端会话能收消息，但暂时不能回发，回报回不到主脑 |
| 其他 AI 编程工具 | ❌ skill 用不了 | 只能手动照搬做法 | — |

欢迎在 issue 里补充实测结果，尤其是 Linux、Windows 和 IDE 插件。

**派活卡片通知**：仅 macOS 桌面 App 适用（新旧版都支持）；其他环境不需要。

**杀进程守卫**：hook 在所有 Claude Code 环境里都生效；在 macOS 桌面 App 上已实测。安装脚本是 bash，Windows 需要手动配置。

**回报格式检查**：在有 `SendMessage` 工具的环境里生效；没有这个工具时，分支会话把回报交给用户转发，hook 不会触发，靠主脑打回。

**桌面 App 专属的工具**（名字带 `ccd_` 前缀）：`start_session`（开新会话派活，旧版叫 `spawn_task`）、`list_sessions` / `get_session` / `archive_session`（盘点和归档会话；`list_sessions` 加 `linked: true` 只列本会话派出的会话）、`set_session_output_style`（切 output style）。其他环境里没有这些工具，skill 会自动退回手动方式，不会报错停下。

**纯命令行版里怎么派活：**
- **推荐**：用 tmux 或终端分屏开几个窗格，一个窗格跑一个 `claude`。主脑把派活提示贴出来，你粘贴到对应窗格。回报通过 `SendMessage` 自动回到主脑。
- **全自动**：主脑用 `Agent` 工具派子代理，每个子代理用独立的 worktree。代价是你没法单独和子代理对话，子代理跑的时候也会占用主脑的上下文。
- output style 可以写进项目的 `.claude/settings.local.json`：`{"outputStyle": "brain"}`。
- 命令行会话的名字每次启动都会变，比如 `<目录名>-51`。主脑每次调用 `/brain` 都会重新登记自己的名字，所以不影响使用；想用固定名字的话，可以执行 `/rename`。

**可以通用的部分**：台账增删改、自报不算验收、变异探针、契约先行、按周交接这些做法，本身跟工具无关，在任何工具里都可以手动照搬。

## 灵感来源与引用

- **Lauren Tan（@poteto）的演讲《All Code Is Slop (Except Mine)》**（[视频](https://www.youtube.com/watch?v=O_zcc6Xl12g)，2026-11）和她的 [pstack](https://github.com/cursor/plugins/tree/main/pstack) 技能集。本仓库借用了这几个思路：
  - 信任靠环境，不靠盯人：约束按“代码与架构 → 静态检查 → 运行验证 → 文字规则”从强到弱排，每次纠正先想能不能落到更强的一层。卡片命令、卡片文件守护、回报格式检查都是这个思路：把写在技能里的规矩变成程序检查。
  - 人审查验证产物，不逐行读改动：回报第 8 栏、主脑重跑产物、合入时把录屏交给用户。
  - 功能地图作为人和智能体的共同词汇；用固定的命令行脚本做验证，保证可复现（见 `docs/design/2026-11-trust.md` 线一）。
  - 先打磨单个会话的闭环，再谈并行规模化。
- **事件溯源**（[Martin Fowler: Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)）：卡片只追加事件、由事件重放出当前状态，历史和指标都从事件算。
- **Claude Code 官方文档**：[钩子](https://code.claude.com/docs/en/hooks)（会话实况用到的权限请求、通知、结束等事件）、插件与看板模组的接口。
- **Apple [Mac Automation Scripting Guide](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html)**：派活卡片通知的做法（见上文）。

这些都只是借鉴做法，本仓库与上述作者和项目没有关联。

## 其他说明

- skill 只能手动调用（`disable-model-invocation: true`），不会被自动触发。

## 许可证

[MIT](LICENSE)
