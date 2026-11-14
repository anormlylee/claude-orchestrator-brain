import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Card, Column, Project, Registry, RegistryEntry } from '../types'

// 项目看板：第一层是项目总览，点项目进入单项目看板。
// 只提醒和查看：没有输入，要动作就进该项目的主脑会话，一次处理完。
// 每张卡片有“带去主脑”：复制卡片内容并跳到主脑会话，到了按 ⌘V 粘贴，不用重打任务描述。

const PANE = 'board'
const REGISTRY = '/Users/jiali/.claude/board/projects.json'
const VISITS = 'board:lastVisit'
const DAY = 86_400_000

const open = atom({ plugin: 'orchestrator', key: 'open' } as const, '')
const colTab = atom({ plugin: 'orchestrator', key: 'col' } as const, 'todo')
const showActs = atom({ plugin: 'orchestrator', key: 'showActs' } as const, false)
const showFrozen = atom({ plugin: 'orchestrator', key: 'showFrozen' } as const, false)
const prevVisit = atom({ plugin: 'orchestrator', key: 'prevVisit' } as const, 0)
const rev = atom({ plugin: 'orchestrator', key: 'rev' } as const, 0)

// ---------- 配色：实心色块给“球在谁”，浅底色块给类型和阶段 ----------
const C = {
  red: '#cf222e',
  orange: '#bc4c00',
  grey: '#6e7781',
  blue: '#0969da',
  purple: '#8250df',
  green: '#1a7f37',
  teal: '#0a7d74',
  amber: '#9a6700',
  pink: '#bf3989',
  cyan: '#0598bc',
}
const tint = (hex: string, a = 0.16) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

const KIND_COLOR: Record<string, string> = {
  功能: C.blue,
  缺陷: C.pink,
  调研: C.cyan,
  决策: C.amber,
  事务: C.grey,
}
const PRIORITY_COLOR: Record<number, string> = { 1: C.red, 2: C.amber, 3: C.grey }

const COLS: { key: Column; label: string; color: string }[] = [
  { key: 'todo', label: '待办', color: C.purple },
  { key: 'doing', label: '进行中', color: C.blue },
  { key: 'verify', label: '待验收', color: C.amber },
  { key: 'done', label: '已完成', color: C.green },
]

// 响应式断点（单位：面板的字符格宽）
const TILE_MIN = 36
const COLUMN_MIN = 30

type Loaded = {
  key: string
  data: Project | undefined
  // 卡片文件还不存在：项目已登记、主脑还没迁移
  missing: boolean
  // 格式问题：看板用来标红框；完整检查由 board/check-cards.py 在主脑保存时做
  problems: string[]
  activityMs: number | undefined
}

const COLUMN_KEYS = ['todo', 'doing', 'verify', 'done', 'frozen']
const KIND_KEYS = ['功能', '缺陷', '调研', '决策', '事务']
const BALL_KEYS = ['you', 'external', 'brain']
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// 看板能不能画出来的最低要求；字数、日期、必填关系交给检查脚本
function shapeProblems(raw: unknown): string[] {
  if (!isObj(raw)) return ['顶层不是对象']
  const out: string[] = []
  if (!isStr(raw.project) || raw.project === '') out.push('缺项目名 project')
  if (raw.stage !== null && !isStr(raw.stage)) out.push('stage 要是文字或 null')
  if (raw.stageGoal !== null && !isStr(raw.stageGoal)) out.push('stageGoal 要是文字或 null')
  if (!isObj(raw.brain) || !isStr(raw.brain.name) || !isStr(raw.brain.id)) out.push('brain 要有 name 和 id')
  if (typeof raw.leftovers !== 'number') out.push('leftovers 要是数字')
  if (!Array.isArray(raw.cards)) return [...out, 'cards 不是列表']
  raw.cards.forEach((c: unknown, i: number) => {
    const at = `第 ${i + 1} 张卡片`
    if (!isObj(c)) {
      out.push(`${at}不是对象`)
      return
    }
    for (const k of ['id', 'title', 'ask', 'now', 'blocked']) {
      if (!isStr(c[k])) out.push(`${at}的 ${k} 不是文字`)
    }
    if (!COLUMN_KEYS.includes(String(c.column))) out.push(`${at}的列 ${String(c.column)} 不认识`)
    if (!KIND_KEYS.includes(String(c.kind))) out.push(`${at}的类型 ${String(c.kind)} 不认识`)
    if (!BALL_KEYS.includes(String(c.ball))) out.push(`${at}的 ball ${String(c.ball)} 不认识`)
    if (c.priority !== null && ![1, 2, 3].includes(c.priority as number)) out.push(`${at}的优先级不是 1 到 3`)
    if (typeof c.milestone !== 'boolean') out.push(`${at}的 milestone 不是 true/false`)
    if (c.askKind !== null && c.askKind !== 'decide' && c.askKind !== 'act') out.push(`${at}的 askKind 不认识`)
    if (c.since !== null && !isStr(c.since)) out.push(`${at}的 since 不是日期`)
    if (c.doneAt !== null && !isStr(c.doneAt)) out.push(`${at}的 doneAt 不是日期`)
  })
  return out
}

const days = (ms: number) => Math.max(0, Math.floor(ms / DAY))
const daysSinceDate = (d: string | null) => (d === null ? undefined : days(Date.now() - Date.parse(d)))
const perRow = (width: number, min: number, max: number) =>
  Math.max(1, Math.min(max, Math.floor((width + 2) / (min + 2))))
const pct = (n: number) => (n === 1 ? '100%' : `${Math.floor(100 / n) - 2}%`)

async function loadAll($: EngineInterface): Promise<Loaded[]> {
  let reg: Registry
  try {
    reg = JSON.parse(await $.fs.read(REGISTRY)) as Registry
  } catch {
    return []
  }
  return Promise.all(
    reg.projects.map(async (p: RegistryEntry): Promise<Loaded> => {
      const mtime = (f: string) => $.fs.stat(f).then(st => st.mtimeMs, () => undefined)
      const [cardsMs, ledgerMs] = await Promise.all([mtime(p.file), mtime(p.activity)])
      // 主脑动静：卡片文件和台账谁更新取谁
      const known = [cardsMs, ledgerMs].filter((v): v is number => v !== undefined)
      const activityMs = known.length > 0 ? Math.max(...known) : undefined
      if (cardsMs === undefined) return { key: p.key, data: undefined, missing: true, problems: [], activityMs }
      let raw: unknown
      try {
        raw = JSON.parse(await $.fs.read(p.file))
      } catch {
        return { key: p.key, data: undefined, missing: false, problems: ['不是合法的 JSON'], activityMs }
      }
      const problems = shapeProblems(raw)
      return { key: p.key, data: problems.length === 0 ? (raw as Project) : undefined, missing: false, problems, activityMs }
    }),
  )
}

async function enter($: EngineInterface, key: string) {
  const visits = ((await $.store.get(VISITS)) ?? {}) as Record<string, number>
  await update($, prevVisit, () => visits[key] ?? 0)
  await $.store.set(VISITS, { ...visits, [key]: Date.now() })
  await update($, colTab, () => 'todo')
  await update($, open, () => key)
}

const stats = (p: Project) => {
  const live = p.cards.filter(c => c.column !== 'frozen')
  const col = (k: Column) => live.filter(c => c.column === k).length
  const you = live.filter(c => c.ball === 'you' && c.column !== 'done')
  const ms = live.filter(c => c.milestone)
  return {
    todo: col('todo'),
    doing: col('doing'),
    verify: col('verify'),
    done: col('done'),
    frozen: p.cards.length - live.length,
    decide: you.filter(c => c.askKind === 'decide').length,
    act: you.filter(c => c.askKind === 'act').length,
    external: live.filter(c => c.ball === 'external' && c.column !== 'done').length,
    msTotal: ms.length,
    msDone: ms.filter(c => c.column === 'done').length,
    msVerify: ms.filter(c => c.column === 'verify').length,
  }
}

const progressSvg = (done: number, verify: number, total: number, width: number) => {
  const w = Math.max(80, width)
  const a = total === 0 ? 0 : (done / total) * w
  const b = total === 0 ? 0 : (verify / total) * w
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="8" viewBox="0 0 ${w} 8">` +
    `<rect x="0" y="0" width="${w}" height="8" rx="4" fill="rgba(128,128,128,0.22)"/>` +
    `<rect x="0" y="0" width="${a + b}" height="8" rx="4" fill="${C.amber}"/>` +
    `<rect x="0" y="0" width="${a}" height="8" rx="4" fill="${C.green}"/>` +
    `</svg>`
  )
}

const textBar = (done: number, verify: number, total: number) => {
  const n = 16
  const a = total === 0 ? 0 : Math.round((done / total) * n)
  const b = total === 0 ? 0 : Math.round((verify / total) * n)
  return '█'.repeat(a) + '▓'.repeat(b) + '░'.repeat(Math.max(0, n - a - b))
}

const activityOf = (ms: number | undefined) => {
  if (ms === undefined) return { text: '主脑动静未知', isStale: false }
  const d = days(Date.now() - ms)
  if (d === 0) return { text: '主脑今天有动静', isStale: false }
  return { text: `主脑 ${d} 天没动`, isStale: d >= 5 }
}

const visitText = (ms: number) => {
  if (ms === 0) return '第一次来看'
  const h = Math.floor((Date.now() - ms) / 3_600_000)
  if (h < 1) return '刚来看过'
  if (h < 24) return `${h} 小时前来看过`
  return `${days(Date.now() - ms)} 天前来看过`
}

// ---------- 带去主脑：把卡片整理成一段话放进剪贴板，再跳到该项目的主脑会话 ----------
// 插件只能往自己所在会话的输入框填字，主脑会话又认不出“这是发给我的”，所以走剪贴板：到了主脑按 ⌘V。
const COLUMN_LABEL: Record<Column, string> = { todo: '待办', doing: '进行中', verify: '待验收', done: '已完成', frozen: '冻结' }
const brainLink = (p: Project) => `claude://claude.ai/epitaxy/${p.brain.id}`
type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

function handoffText(p: Project, c: Card): string {
  const status: string[] = [COLUMN_LABEL[c.column], c.kind]
  if (c.priority !== null) status.push(`P${c.priority}`)
  if (c.milestone) status.push('阶段目标')
  const lines = [`关于看板卡片「${c.title}」（${p.project}，卡片编号 ${c.id}）`, `- 状态：${status.join('，')}`]
  if (c.now !== '') lines.push(`- 现状：${c.now}`)
  if (c.ball === 'you' && c.column !== 'done' && c.ask !== '') {
    lines.push(`- 等我${c.askKind === 'decide' ? '拍板' : '动手'}：${c.ask}`)
  }
  if (c.ball === 'external' && c.column !== 'done') lines.push('- 在等外部')
  if (c.blocked !== '') lines.push(`- 阻塞：${c.blocked}`)
  lines.push('', '我的指示：')
  return lines.join('\n')
}

async function handoff($: EngineInterface, p: Project, c: Card, surface: Surface) {
  const text = handoffText(p, c)
  // 先用系统剪贴板命令（桌面 App 和终端都可靠），不行再用界面自带的复制
  // 不指定 UTF-8 时 pbcopy 会把中文悄悄丢掉（实测：退出码 0，剪贴板为空）
  let copied = await $.process.run(['pbcopy'], { stdin: text, env: { LANG: 'en_US.UTF-8' }, timeoutMs: 5000 })
    .then(r => r.exitCode === 0, () => false)
  if (!copied) copied = await $.ui.copy({ text, surface }).then(r => r.isCopied, () => false)
  const jumped = await $.process.run(['open', brainLink(p)], { timeoutMs: 5000 })
    .then(r => r.exitCode === 0, () => false)
  if (copied && jumped) $.ui.toast(`已复制卡片「${c.title}」，到主脑会话后按 ⌘V 粘贴`)
  else if (copied) $.ui.toast('已复制卡片，但没能自动跳转：请点项目上方的“进入主脑会话”，再按 ⌘V')
  else $.ui.toast('复制失败：剪贴板不可用')
}

const byPriority = (a: Card, b: Card) =>
  (a.priority ?? 9) - (b.priority ?? 9) || (a.ball === 'you' ? 0 : 1) - (b.ball === 'you' ? 0 : 1)

let lastStamp = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: '打开项目看板' })
    // 卡片文件或台账有变化，看板 5 秒内跟上
    $.clock.every(5000, () => {
      void (async () => {
        const reg = JSON.parse(await $.fs.read(REGISTRY)) as Registry
        const stamps = await Promise.all(
          reg.projects.flatMap(p => [p.file, p.activity]).map(f =>
            $.fs.stat(f).then(s => s.mtimeMs, () => 0),
          ),
        )
        const stamp = stamps.join(',')
        if (stamp !== lastStamp) {
          lastStamp = stamp
          await update($, rev, n => n + 1)
        }
      })().catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: '项目看板' })
    return { text: '项目看板已打开。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    const canSvg = 'Svg' in els
    const width = e.props.bodyColumns

    await read($, rev)
    const projects = await loadAll($)
    const current = await read($, open)
    const tab = await read($, colTab)
    const actsOpen = await read($, showActs)
    const frozenOpen = await read($, showFrozen)
    const prev = await read($, prevVisit)

    // 实心色块：白字彩底，用于“球在谁”和醒目提醒
    const pill = (label: string, color: string) => (
      <Text backgroundColor={color} color="#ffffff" weight="semibold" size="caption">{` ${label} `}</Text>
    )
    // 浅底色块：彩字浅底，用于类型、阶段、优先级
    const soft = (label: string, color: string) => (
      <Text backgroundColor={tint(color)} color={color} weight="medium" size="caption">{` ${label} `}</Text>
    )
    // 标签组：每个标签是独立色块，放在可折行的横排里，窄了自动换行
    const chips = (list: ReturnType<typeof pill>[]) => (
      <Box flexDirection="row" flexWrap="wrap" gap="xs">{list}</Box>
    )
    // 统计块：上面大号数字，下面小字说明；几块横排，窄了折行
    const statBlock = (num: number, label: string, color: string) => (
      <Box flexDirection="column" minWidth={6}>
        <Text size="heading" weight="bold" color={num > 0 ? color : undefined} dimColor={num === 0}>{String(num)}</Text>
        <Text size="caption" dimColor>{label}</Text>
      </Box>
    )
    const stats4 = (list: ReturnType<typeof statBlock>[]) => (
      <Box flexDirection="row" flexWrap="wrap" columnGap="md" rowGap="xs">{list}</Box>
    )

    const bar = (done: number, verify: number, total: number, px: number) =>
      canSvg ? (
        <els.Svg source={progressSvg(done, verify, total, px)} alt={`阶段目标 ${done}/${total}`} />
      ) : (
        <Text>{textBar(done, verify, total)}</Text>
      )

    // 进度区：进度条在上，说明在下
    const progress = (s: ReturnType<typeof stats>, px: number) =>
      s.msTotal > 0 ? (
        <Box flexDirection="column" gap="xs">
          {bar(s.msDone, s.msVerify, s.msTotal, px)}
          <Text size="caption" dimColor>
            阶段目标 {s.msDone}/{s.msTotal} 完成{s.msVerify > 0 ? `，${s.msVerify} 项待验收` : ''}
          </Text>
        </Box>
      ) : (
        <Text size="caption" color={C.orange}>还没有阶段目标：由主脑提出，你确认后才有进度</Text>
      )

    // 等你区：拍板、动手、等外部各一个实心色块
    const waiting = (s: ReturnType<typeof stats>) => {
      const list: ReturnType<typeof pill>[] = []
      if (s.decide > 0) list.push(pill(`拍板 ${s.decide}`, C.red))
      if (s.act > 0) list.push(pill(`动手 ${s.act}`, C.orange))
      if (s.external > 0) list.push(pill(`等外部 ${s.external}`, C.grey))
      if (list.length === 0) list.push(soft('没有等你的事', C.green))
      return chips(list)
    }

    // ---------- 单项目看板 ----------
    const proj = projects.find(p => p.key === current)
    if (proj !== undefined && proj.data !== undefined) {
      const p = proj.data
      const s = stats(p)
      const act = activityOf(proj.activityMs)
      const n = perRow(width, COLUMN_MIN, 4)

      const tags = (c: Card) => {
        const parts: ReturnType<typeof pill>[] = []
        if (c.ball === 'you' && c.column !== 'done') {
          parts.push(c.askKind === 'decide' ? pill('等你拍板', C.red) : pill('等你动手', C.orange))
        }
        if (c.ball === 'external' && c.column !== 'done') parts.push(pill('等外部', C.grey))
        if (c.priority !== null) parts.push(soft(`P${c.priority}`, PRIORITY_COLOR[c.priority] ?? C.grey))
        parts.push(soft(c.kind, KIND_COLOR[c.kind] ?? C.grey))
        if (c.milestone) parts.push(soft('◆ 阶段目标', C.teal))
        return chips(parts)
      }

      // 卡片：自上而下分区——标签、标题、现状、要你、阻塞、角注
      const cardView = (c: Card) => {
        const d = daysSinceDate(c.since)
        const isYou = c.ball === 'you' && c.column !== 'done'
        return (
          <Box key={`card:${c.id}`} flexDirection="column" borderStyle="round"
            borderColor={isYou ? (c.askKind === 'decide' ? C.red : C.orange) : 'promptBorder'}
            padding="sm" gap="xs">
            {tags(c)}
            <Text weight="semibold">{c.title}</Text>
            {c.now !== '' && <Text size="footnote" dimColor>{c.now}</Text>}
            {isYou && c.ask !== '' && (
              <Box flexDirection="column" padding="xs" backgroundColor={tint(c.askKind === 'decide' ? C.red : C.orange, 0.08)}>
                <Text size="caption" weight="semibold" color={c.askKind === 'decide' ? C.red : C.orange}>要你</Text>
                <Text size="footnote">{c.ask}</Text>
              </Box>
            )}
            {c.blocked !== '' && (
              <Box flexDirection="column" padding="xs" backgroundColor={tint(C.red, 0.08)}>
                <Text size="caption" weight="semibold" color={C.red}>⛔ 阻塞</Text>
                <Text size="footnote">{c.blocked}</Text>
              </Box>
            )}
            <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center">
              <Button key={`handoff:${c.id}`} plain label="带去主脑 ›"
                onPress={press => handoff($, p, c, press.surface)} />
              {d !== undefined && c.column !== 'done' && (
                <Text size="caption" dimColor>在这一列 {d} 天</Text>
              )}
            </Box>
          </Box>
        )
      }

      const columnView = (k: Column) => {
        const meta = COLS.find(x => x.key === k) ?? COLS[0]!
        const list = p.cards.filter(c => c.column === k).sort(byPriority)
        return (
          <Box key={`col:${k}`} flexDirection="column" gap="sm" padding="sm"
            backgroundColor={tint(meta.color, 0.07)} width={pct(Math.min(n, 4))}>
            <Box flexDirection="row" gap="xs" alignItems="center">
              <Text color={meta.color} weight="bold">● {meta.label}</Text>
              {soft(String(list.length), meta.color)}
            </Box>
            {list.length === 0 && <Text size="caption" dimColor>（空）</Text>}
            {list.map(cardView)}
            {k === 'todo' && p.leftovers > 0 && (
              <Text size="caption" dimColor>＋ 遗留小项 {p.leftovers} 件（在台账里，由主脑挑出来排期）</Text>
            )}
          </Box>
        )
      }

      const frozen = p.cards.filter(c => c.column === 'frozen')
      const count = (k: Column) => p.cards.filter(c => c.column === k).length

      return (
        <Box flexDirection="column" gap="md" paddingX="xs">
          <Box flexDirection="row">
            <Button key="back" onPress={() => update($, open, () => '')} label="← 全部项目" />
          </Box>

          <Box flexDirection="column" gap="sm" padding="sm" borderStyle="round"
            borderColor={act.isStale ? C.red : 'promptBorder'}>
            <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center">
              <Text size="title" weight="bold">{p.project}</Text>
              {p.stage !== null ? soft(p.stage, C.teal) : soft('阶段目标未定', C.orange)}
            </Box>
            {p.stageGoal !== null && <Text size="footnote" dimColor>阶段目标：{p.stageGoal}</Text>}
            {progress(s, 320)}
            {stats4([
              statBlock(s.todo, '待办', C.purple),
              statBlock(s.doing, '进行中', C.blue),
              statBlock(s.verify, '待验收', C.amber),
              statBlock(s.done, '已完成', C.green),
            ])}
            {waiting(s)}
            <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center">
              {act.isStale ? pill(act.text, C.red) : <Text size="caption" dimColor>{act.text}</Text>}
              <Text size="caption" dimColor>· {visitText(prev)} · 冻结 {s.frozen} · 遗留 {p.leftovers}</Text>
            </Box>
            <Link href={brainLink(p)} label={`→ 进入主脑会话：${p.brain.name}`} />
          </Box>

          {n === 1 && (
            <Box flexDirection="row" flexWrap="wrap" gap="xs">
              {COLS.map(c => (
                <Button key={`tab:${c.key}`} variant={tab === c.key ? 'primary' : 'secondary'}
                  onPress={() => update($, colTab, () => c.key)} label={`${c.label} ${count(c.key)}`} />
              ))}
            </Box>
          )}

          <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="flex-start">
            {(n === 1 ? COLS.filter(c => c.key === tab) : COLS).map(c => columnView(c.key))}
          </Box>

          {frozen.length > 0 && (
            <Box flexDirection="column" gap="sm">
              <Button key="frozen-toggle" plain onPress={() => update($, showFrozen, v => !v)}
                label={`${frozenOpen ? '▾' : '▸'} 冻结 ${frozen.length} 项`} />
              {frozenOpen && (
                <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="flex-start">
                  {frozen.map(c => (
                    <Box key={`fz:${c.id}`} width={pct(n)}>{cardView(c)}</Box>
                  ))}
                </Box>
              )}
            </Box>
          )}

          <Text size="caption" dimColor>面板宽 {width} 格 · 每行 {n} 列</Text>
        </Box>
      )
    }

    // ---------- 项目总览 ----------
    const n = perRow(width, TILE_MIN, 3)
    const visits = ((await $.store.get(VISITS)) ?? {}) as Record<string, number>

    // 项目卡：自上而下分区——标题行、阶段目标、进度、统计、等你、角注
    const tile = (l: Loaded) => {
      if (l.missing) {
        return (
          <Box key={`tile:${l.key}`} flexDirection="column" borderStyle="round" borderColor="promptBorder"
            padding="sm" gap="xs" width={pct(n)}>
            <Text size="heading" weight="bold">{l.key}</Text>
            {soft('还没迁移到卡片', C.grey)}
            <Text size="caption" dimColor>主脑下次被唤醒时会把台账转成卡片</Text>
          </Box>
        )
      }
      if (l.data === undefined) {
        return (
          <Box key={`tile:${l.key}`} flexDirection="column" borderStyle="round" borderColor={C.red}
            padding="sm" gap="xs" width={pct(n)}>
            <Text size="heading" weight="bold">{l.key}</Text>
            {pill('卡片文件格式不合格', C.red)}
            {l.problems.slice(0, 3).map(t => <Text size="caption" color={C.red}>· {t}</Text>)}
            {l.problems.length > 3 && <Text size="caption" dimColor>还有 {l.problems.length - 3} 个问题</Text>}
            <Text size="caption" dimColor>让主脑用 check-cards.py 检查并改好</Text>
          </Box>
        )
      }
      const p = l.data
      const s = stats(p)
      const act = activityOf(l.activityMs)
      const youTotal = s.decide + s.act

      return (
        <Box key={`tile:${l.key}`} flexDirection="column" borderStyle="round"
          borderColor={act.isStale ? C.red : youTotal > 0 ? C.orange : 'promptBorder'}
          hover={{ borderColor: C.blue, backgroundColor: tint(C.blue, 0.05) }}
          padding="sm" gap="sm" width={pct(n)}>
          <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap="xs">
            <Text size="heading" weight="bold">{p.project}</Text>
            {p.stage !== null ? soft(p.stage, C.teal) : soft('阶段目标未定', C.orange)}
          </Box>
          {p.stageGoal !== null && <Text size="footnote" dimColor>{p.stageGoal}</Text>}
          {progress(s, 200)}
          {stats4([
            statBlock(s.doing, '进行中', C.blue),
            statBlock(s.verify, '待验收', C.amber),
            statBlock(s.todo, '待办', C.purple),
          ])}
          {waiting(s)}
          <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center">
            {act.isStale ? pill(act.text, C.red) : <Text size="caption" dimColor>{act.text}</Text>}
            <Text size="caption" dimColor>· {visitText(visits[l.key] ?? 0)}</Text>
          </Box>
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key={`enter:${l.key}`} variant={youTotal > 0 ? 'primary' : 'secondary'}
              onPress={() => void enter($, l.key)} label="进入项目 ›" />
          </Box>
        </Box>
      )
    }

    // 跨项目只汇总“纯动手”的事：不用装载项目背景，攒一起做不吃亏
    const acts = projects.flatMap(l =>
      (l.data?.cards ?? [])
        .filter(c => c.ball === 'you' && c.askKind === 'act' && c.column !== 'done' && c.column !== 'frozen')
        .map(c => ({ key: l.key, card: c })),
    )

    return (
      <Box flexDirection="column" gap="md" paddingX="xs">
        <Box flexDirection="column">
          <Text size="title" weight="bold">项目看板</Text>
          <Text size="caption" dimColor>点块底部的“进入项目”。项目按固定顺序排列，不按紧急程度重排。</Text>
        </Box>

        <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="flex-start">
          {projects.map(tile)}
        </Box>

        <Box flexDirection="column" gap="sm">
          <Button key="acts-toggle" plain onPress={() => update($, showActs, v => !v)}
            label={`${actsOpen ? '▾' : '▸'} 纯动手的事 ${acts.length} 件（跨项目汇总，不用装载项目背景）`} />
          {actsOpen && (
            <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="flex-start">
              {projects
                .filter(l => acts.some(a => a.key === l.key))
                .map(l => (
                  <Box key={`acts:${l.key}`} flexDirection="column" padding="sm" gap="xs" width={pct(n)}
                    backgroundColor={tint(C.orange, 0.07)}>
                    <Text weight="semibold" size="footnote">{l.data?.project ?? l.key}</Text>
                    {acts.filter(a => a.key === l.key).map(a => <Text size="footnote">· {a.card.ask}</Text>)}
                  </Box>
                ))}
            </Box>
          )}
        </Box>

        <Text size="caption" dimColor>
          主脑动静取卡片文件和台账里较新的修改时间 · 面板宽 {width} 格 · 每行 {n} 块
        </Text>
      </Box>
    )
  })
}
