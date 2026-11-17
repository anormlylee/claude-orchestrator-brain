import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Card, Column, LiveSession, Project, Registry, RegistryEntry, Window } from '../types'

// 项目看板。第一屏是“现在要我做的”：只放落在用户身上的事，按项目分组、项目按登记顺序固定排列
// （注意力的单位是项目：同一项目的几件事一起处理，切换成本最低；不做跨项目平铺的待办清单）。
// 下面是全部项目块，点进去看单项目看板。
// 数据三份：
//   各项目的 cards.json：主脑用卡片命令（board/card.py）记事件，命令生成这份“现在”；
//   ~/.claude/board/live/：每个会话由 board/live.sh 写下自己的实况（在跑、等你批准、停了）；
//   ~/.claude/board/pending/：“带去主脑”时留给主脑会话的待填内容，主脑会话里的本插件读到后填进输入框。
// 设计见 docs/design/2026-11-board.md。

const PANE = 'board'
const VISITS = 'board:lastVisit'
const DAY = 86_400_000
const HOUR = 3_600_000
const STALL_MS = 3 * HOUR // 进行中的卡，会话停了超过这么久算停滞
const LIVE_MAX_AGE = 3 * DAY // 更旧的实况文件当作不在线
const PENDING_TTL = 10 * 60_000 // 留给主脑的待填内容，过期不填
const DELIVERED_DAYS = 3 // 新交付在队列里留几天

const open = atom({ plugin: 'orchestrator', key: 'open' } as const, '')
const colTab = atom({ plugin: 'orchestrator', key: 'col' } as const, 'todo')
const showFrozen = atom({ plugin: 'orchestrator', key: 'showFrozen' } as const, false)
const prevVisit = atom({ plugin: 'orchestrator', key: 'prevVisit' } as const, 0)
const rev = atom({ plugin: 'orchestrator', key: 'rev' } as const, 0)

// ---------- 配色：实心色块给“要你动”，浅底色块给类型和状态 ----------
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
const COLUMN_LABEL: Record<Column, string> = { todo: '待办', doing: '进行中', verify: '待验收', done: '已完成', frozen: '冻结' }

// 响应式断点（单位：面板的字符格宽）
const TILE_MIN = 36
const COLUMN_MIN = 30

// ---------- 路径：家目录在会话开始时取一次 ----------
let home = ''
let hostId = ''
const boardDir = () => `${home}/.claude/board`
const registryPath = () => `${boardDir()}/projects.json`
const liveDir = () => `${boardDir()}/live`
const pendingDir = () => `${boardDir()}/pending`
const sessionLink = (id: string) => `claude://claude.ai/epitaxy/${id}`

async function readEnv($: EngineInterface) {
  home = (await $.env.get('HOME')) ?? ''
  hostId = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) ?? ''
}

type Loaded = {
  key: string
  root: string
  data: Project | undefined
  // 卡片文件还不存在：项目已登记、主脑还没迁移
  missing: boolean
  // 格式问题：看板用来标红框；完整检查在 board/card.py 生成时做
  problems: string[]
  activityMs: number | undefined
}

const COLUMN_KEYS = ['todo', 'doing', 'verify', 'done', 'frozen']
const KIND_KEYS = ['功能', '缺陷', '调研', '决策', '事务']
const BALL_KEYS = ['you', 'external', 'brain']
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// 看板能不能画出来的最低要求；完整规则在 board/check-cards.py
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
    if (c.sessions !== undefined && !(Array.isArray(c.sessions) && c.sessions.every(isStr))) out.push(`${at}的 sessions 不是会话编号列表`)
  })
  return out
}

const days = (ms: number) => Math.max(0, Math.floor(ms / DAY))
const daysSinceDate = (d: string | null) => (d === null ? undefined : days(Date.now() - Date.parse(d)))
const ageText = (ms: number) => {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`
  if (ms < DAY) return `${Math.floor(ms / HOUR)} 小时`
  return `${days(ms)} 天`
}
const perRow = (width: number, min: number, max: number) =>
  Math.max(1, Math.min(max, Math.floor((width + 2) / (min + 2))))
const pct = (n: number) => (n === 1 ? '100%' : `${Math.floor(100 / n) - 2}%`)
const rootOf = (p: RegistryEntry) => p.root ?? p.file.replace(/\/(docs\/)?brain\/cards\.json$/, '')

async function readRegistry($: EngineInterface): Promise<Registry> {
  return JSON.parse(await $.fs.read(registryPath())) as Registry
}

async function loadAll($: EngineInterface): Promise<Loaded[]> {
  let reg: Registry
  try {
    reg = await readRegistry($)
  } catch {
    return []
  }
  return Promise.all(
    reg.projects.map(async (p: RegistryEntry): Promise<Loaded> => {
      const root = rootOf(p)
      const mtime = (f: string) => $.fs.stat(f).then(st => st.mtimeMs, () => undefined)
      const [cardsMs, ledgerMs] = await Promise.all([mtime(p.file), mtime(p.activity)])
      // 主脑动静：卡片文件和台账谁更新取谁
      const known = [cardsMs, ledgerMs].filter((v): v is number => v !== undefined)
      const activityMs = known.length > 0 ? Math.max(...known) : undefined
      if (cardsMs === undefined) return { key: p.key, root, data: undefined, missing: true, problems: [], activityMs }
      let raw: unknown
      try {
        raw = JSON.parse(await $.fs.read(p.file))
      } catch {
        return { key: p.key, root, data: undefined, missing: false, problems: ['不是合法的 JSON'], activityMs }
      }
      const problems = shapeProblems(raw)
      return { key: p.key, root, data: problems.length === 0 ? (raw as Project) : undefined, missing: false, problems, activityMs }
    }),
  )
}

async function loadLive($: EngineInterface): Promise<Map<string, LiveSession>> {
  const out = new Map<string, LiveSession>()
  const entries = await $.fs.list(liveDir()).catch(() => [])
  await Promise.all(
    entries
      .filter(f => f.kind === 'file' && f.name.endsWith('.json') && !f.name.startsWith('.'))
      .map(async f => {
        try {
          const s = JSON.parse(await $.fs.read(`${liveDir()}/${f.name}`)) as LiveSession
          if (isStr(s.id) && Date.now() - s.at * 1000 < LIVE_MAX_AGE) out.set(s.id, s)
        } catch {
          // 正在被改写的文件下一轮再读
        }
      }),
  )
  return out
}

async function enter($: EngineInterface, key: string) {
  const visits = ((await $.store.get(VISITS)) ?? {}) as Record<string, number>
  await update($, prevVisit, () => visits[key] ?? 0)
  await $.store.set(VISITS, { ...visits, [key]: Date.now() })
  await update($, colTab, () => 'todo')
  await update($, open, () => key)
}

// ---------- 会话实况 ----------
type Pulse = { kind: 'waiting' | 'running' | 'error' | 'stalled' | 'idle' | 'offline'; ms: number }

// 一张卡的会话里取最要紧的状态：等你批准 > 出错 > 在跑 > 停滞 > 空闲 > 不在线
function pulseOf(c: Card, live: Map<string, LiveSession>): Pulse | undefined {
  const ids = c.sessions ?? []
  if (ids.length === 0 || c.column === 'done' || c.column === 'frozen') return undefined
  const found = ids.map(id => live.get(id)).filter((s): s is LiveSession => s !== undefined)
  const age = (s: LiveSession) => Date.now() - s.at * 1000
  const pick = (st: LiveSession['state']) => found.find(s => s.state === st)
  const w = pick('waiting')
  if (w) return { kind: 'waiting', ms: age(w) }
  const er = pick('error')
  if (er) return { kind: 'error', ms: age(er) }
  const r = pick('running')
  if (r) return { kind: 'running', ms: age(r) }
  if (found.length === 0) return { kind: 'offline', ms: 0 }
  const freshest = Math.min(...found.map(age))
  return { kind: c.column === 'doing' && freshest > STALL_MS ? 'stalled' : 'idle', ms: freshest }
}

// ---------- 带去主脑：跳到主脑会话，卡片内容自动填进它的输入框 ----------
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
  if (c.evidence !== undefined) lines.push(`- 验证产物：${c.evidence}`)
  lines.push('', '我的指示：')
  return lines.join('\n')
}

async function openUrl($: EngineInterface, url: string) {
  return $.process.run(['open', url], { timeoutMs: 5000 }).then(r => r.exitCode === 0, () => false)
}

async function handoff($: EngineInterface, p: Project, c: Card, surface: Surface) {
  const text = handoffText(p, c)
  // 1. 留给主脑会话：它里面的本插件每 2 秒看一次，读到就填进输入框
  const left = await $.process.run(['mkdir', '-p', pendingDir()], { timeoutMs: 3000 })
    .then(() => $.fs.write(`${pendingDir()}/${p.brain.id}.json`, JSON.stringify({ text, at: Date.now() })))
    .then(() => true, () => false)
  // 2. 剪贴板兜底（主脑会话没开着、或者填写失败时按 ⌘V）。不指定 UTF-8 时 pbcopy 会把中文悄悄丢掉
  let copied = await $.process.run(['pbcopy'], { stdin: text, env: { LANG: 'en_US.UTF-8' }, timeoutMs: 5000 })
    .then(r => r.exitCode === 0, () => false)
  if (!copied) copied = await $.ui.copy({ text, surface }).then(r => r.isCopied, () => false)
  const jumped = await openUrl($, sessionLink(p.brain.id))
  if (!jumped) $.ui.toast('没能跳转到主脑会话：请点项目里的“进入主脑会话”')
  else if (left) $.ui.toast(`已带着「${c.title}」去主脑会话，内容会自动填进输入框${copied ? '（没填上就按 ⌘V）' : ''}`)
  else if (copied) $.ui.toast(`已复制「${c.title}」，到主脑会话后按 ⌘V`)
  else $.ui.toast('没能带上卡片内容：请在主脑会话里说卡片编号 ' + c.id)
}

// 本会话是某个主脑时：把看板留下的内容填进输入框
async function consumePending($: EngineInterface) {
  if (hostId === '' || home === '') return
  const path = `${pendingDir()}/${hostId}.json`
  if (!(await $.fs.exists(path))) return
  const remove = () => $.process.run(['rm', '-f', path], { timeoutMs: 3000 }).catch(() => undefined)
  let item: { text: string; at: number }
  try {
    item = JSON.parse(await $.fs.read(path)) as { text: string; at: number }
  } catch {
    await remove()
    return
  }
  if (!isStr(item.text) || Date.now() - item.at > PENDING_TTL) {
    await remove()
    return
  }
  const box = await $.prompt.read()
  const filled = await $.prompt.fill(
    box.text.trim() === '' ? { text: item.text } : { text: `\n\n${item.text}`, mode: 'append' },
  ).then(r => r.isFilled, () => false)
  if (filled) {
    await remove()
    $.ui.toast('已把看板卡片填进输入框，补一句指示就能发')
  }
}

const byPriority = (a: Card, b: Card) =>
  (a.priority ?? 9) - (b.priority ?? 9) || (a.ball === 'you' ? 0 : 1) - (b.ball === 'you' ? 0 : 1)

// ---------- “现在要我做的”队列 ----------
type Item = {
  key: string
  kind: 'waiting' | 'decide' | 'act' | 'delivered'
  project: Loaded & { data: Project }
  card?: Card
  session?: LiveSession
  ageMs: number | undefined
}
const ITEM_ORDER: Record<Item['kind'], number> = { waiting: 0, decide: 1, act: 2, delivered: 3 }

// 本项目里等你批准的会话：卡片关联的，或者在本项目目录里跑的未登记会话
function waitingIn(l: Loaded, live: Map<string, LiveSession>): { session: LiveSession; card: Card | undefined }[] {
  const linked = new Map<string, Card>()
  for (const c of l.data?.cards ?? []) for (const id of c.sessions ?? []) linked.set(id, c)
  const out: { session: LiveSession; card: Card | undefined }[] = []
  for (const s of live.values()) {
    if (s.state !== 'waiting') continue
    const card = linked.get(s.id)
    if (card === undefined && !(s.project === l.root || s.project.startsWith(`${l.root}/`))) continue
    out.push({ session: s, card })
  }
  return out
}

function queueOf(projects: Loaded[], live: Map<string, LiveSession>): Item[] {
  const items: Item[] = []
  for (const l of projects) {
    if (l.data === undefined) continue
    const proj = l as Loaded & { data: Project }
    // 1. 等你批准的会话
    for (const { session: s, card } of waitingIn(l, live)) {
      items.push({ key: `w:${s.id}`, kind: 'waiting', project: proj, card, session: s, ageMs: Date.now() - s.at * 1000 })
    }
    for (const c of l.data.cards) {
      if (c.column === 'frozen') continue
      const since = c.since === null ? undefined : Date.now() - Date.parse(c.since)
      if (c.ball === 'you' && c.column !== 'done' && c.askKind !== null) {
        items.push({ key: `c:${l.key}:${c.id}`, kind: c.askKind, project: proj, card: c, ageMs: since })
      }
      // 2. 新交付：带验证产物、最近几天完成的，给用户看录屏
      if (c.column === 'done' && c.evidence !== undefined && c.doneAt !== null && Date.now() - Date.parse(c.doneAt) < DELIVERED_DAYS * DAY) {
        items.push({ key: `d:${l.key}:${c.id}`, kind: 'delivered', project: proj, card: c, ageMs: Date.now() - Date.parse(c.doneAt) })
      }
    }
  }
  return items.sort(
    (a, b) =>
      ITEM_ORDER[a.kind] - ITEM_ORDER[b.kind] ||
      (a.card?.priority ?? 9) - (b.card?.priority ?? 9) ||
      (b.ageMs ?? 0) - (a.ageMs ?? 0),
  )
}

let lastStamp = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: '打开项目看板' })
    await readEnv($)
    // 本会话若是某个主脑，看板“带去主脑”留下的内容 2 秒内填进输入框
    $.clock.every(2000, () => {
      void consumePending($).catch(() => undefined)
    })
    // 卡片文件、台账、会话实况有变化，看板 5 秒内跟上
    $.clock.every(5000, () => {
      void (async () => {
        if (home === '') return
        const reg = await readRegistry($)
        const stamps = await Promise.all(
          reg.projects.flatMap(p => [p.file, p.activity]).map(f => $.fs.stat(f).then(s => s.mtimeMs, () => 0)),
        )
        const live = await $.fs.list(liveDir()).catch(() => [])
        const stamp = [...stamps, ...live.map(f => `${f.name}@${f.mtimeMs}`)].join(',')
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
    if (home === '') await readEnv($)
    const [projects, live] = await Promise.all([loadAll($), loadLive($)])
    const current = await read($, open)
    const tab = await read($, colTab)
    const frozenOpen = await read($, showFrozen)
    const prev = await read($, prevVisit)

    // 实心色块：白字彩底，用于“要你动”和醒目提醒
    const pill = (label: string, color: string) => (
      <Text backgroundColor={color} color="#ffffff" weight="semibold" size="caption">{` ${label} `}</Text>
    )
    // 浅底色块：彩字浅底，用于类型、状态、优先级
    const soft = (label: string, color: string) => (
      <Text backgroundColor={tint(color)} color={color} weight="medium" size="caption">{` ${label} `}</Text>
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

    const progressSvg = (done: number, verify: number, total: number, w0: number) => {
      const w = Math.max(80, w0)
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
    const bar = (done: number, verify: number, total: number, px: number) =>
      canSvg ? (
        <els.Svg source={progressSvg(done, verify, total, px)} alt={`阶段目标 ${done}/${total}`} />
      ) : (
        <Text>{textBar(done, verify, total)}</Text>
      )

    const stats = (l: Loaded & { data: Project }) => {
      const p = l.data
      const live2 = p.cards.filter(c => c.column !== 'frozen')
      const col = (k: Column) => live2.filter(c => c.column === k).length
      const you = live2.filter(c => c.ball === 'you' && c.column !== 'done')
      const ms = live2.filter(c => c.milestone)
      const pulses = live2.map(c => pulseOf(c, live)).filter((x): x is Pulse => x !== undefined)
      return {
        todo: col('todo'),
        doing: col('doing'),
        verify: col('verify'),
        done: col('done'),
        frozen: p.cards.length - live2.length,
        decide: you.filter(c => c.askKind === 'decide').length,
        act: you.filter(c => c.askKind === 'act').length,
        external: live2.filter(c => c.ball === 'external' && c.column !== 'done').length,
        msTotal: ms.length,
        msDone: ms.filter(c => c.column === 'done').length,
        msVerify: ms.filter(c => c.column === 'verify').length,
        running: pulses.filter(x => x.kind === 'running').length,
        waiting: waitingIn(l, live).length,
        stalled: pulses.filter(x => x.kind === 'stalled' || x.kind === 'error').length,
      }
    }
    type Stats = ReturnType<typeof stats>

    // 进度区：进度条在上，说明在下
    const progress = (s: Stats, px: number) =>
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

    // 等你区：拍板、动手、等外部各一个色块
    const waitingChips = (s: Stats) => {
      const list: ReturnType<typeof pill>[] = []
      if (s.decide > 0) list.push(pill(`拍板 ${s.decide}`, C.red))
      if (s.act > 0) list.push(pill(`动手 ${s.act}`, C.orange))
      if (s.external > 0) list.push(pill(`等外部 ${s.external}`, C.grey))
      if (list.length === 0) list.push(soft('没有等你的事', C.green))
      return chips(list)
    }

    // 会话区：在跑、等你批准、停滞
    const liveChips = (s: Stats) => {
      const list: ReturnType<typeof pill>[] = []
      if (s.waiting > 0) list.push(pill(`会话等你批准 ${s.waiting}`, C.red))
      if (s.stalled > 0) list.push(pill(`会话停滞 ${s.stalled}`, C.amber))
      if (s.running > 0) list.push(soft(`● 在跑 ${s.running}`, C.blue))
      if (list.length === 0) list.push(soft('没有在飞的会话', C.grey))
      return chips(list)
    }

    // 信任指标：近 7 天和本阶段的完成、打回、返工
    const trustLine = (label: string, w: Window | undefined) =>
      w === undefined ? null : (
        <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center">
          <Text size="caption" dimColor>{label}</Text>
          {soft(`完成 ${w.done}`, C.green)}
          {soft(`打回 ${w.rejects}`, w.rejects > 0 ? C.amber : C.green)}
          {soft(`返工 ${w.rework}`, w.rework > 0 ? C.red : C.green)}
        </Box>
      )
    const trust = (p: Project) => (
      <Box flexDirection="column" gap="xs">
        {trustLine('近 7 天', p.stats?.week)}
        {trustLine('本阶段', p.stats?.stage)}
      </Box>
    )

    const pulseChip = (x: Pulse | undefined) => {
      if (x === undefined) return null
      if (x.kind === 'waiting') return pill(`会话等你批准 ${ageText(x.ms)}`, C.red)
      if (x.kind === 'error') return pill('会话出错中断', C.red)
      if (x.kind === 'running') return soft('● 会话在跑', C.blue)
      if (x.kind === 'stalled') return pill(`会话停了 ${ageText(x.ms)}`, C.amber)
      if (x.kind === 'idle') return soft(`会话空闲 ${ageText(x.ms)}`, C.grey)
      return soft('会话不在线', C.grey)
    }

    const handoffButton = (key: string, p: Project, c: Card, primary = false) => (
      primary ? (
        <Button key={key} variant="primary" label="带去主脑 ›" onPress={press => handoff($, p, c, press.surface)} />
      ) : (
        <Button key={key} plain label="带去主脑 ›" onPress={press => handoff($, p, c, press.surface)} />
      )
    )
    const evidenceButton = (key: string, root: string, c: Card) =>
      c.evidence === undefined ? null : (
        <Button key={key} plain label="看验证产物 ›"
          onPress={() => void openUrl($, c.evidence!.startsWith('/') ? c.evidence! : `${root}/${c.evidence}`)} />
      )

    // ---------- 单项目看板 ----------
    const proj = projects.find(p => p.key === current)
    if (proj !== undefined && proj.data !== undefined) {
      const p = proj.data
      const s = stats(proj as Loaded & { data: Project })
      const act = activityOf(proj.activityMs)
      const n = perRow(width, COLUMN_MIN, 4)

      const tags = (c: Card) => {
        const parts: ReturnType<typeof pill>[] = []
        if (c.ball === 'you' && c.column !== 'done') {
          parts.push(c.askKind === 'decide' ? pill('等你拍板', C.red) : pill('等你动手', C.orange))
        }
        if (c.ball === 'external' && c.column !== 'done') parts.push(pill('等外部', C.grey))
        const pc = pulseChip(pulseOf(c, live))
        if (pc !== null) parts.push(pc)
        if (c.priority !== null) parts.push(soft(`P${c.priority}`, PRIORITY_COLOR[c.priority] ?? C.grey))
        parts.push(soft(c.kind, KIND_COLOR[c.kind] ?? C.grey))
        if (c.milestone) parts.push(soft('◆ 阶段目标', C.teal))
        if (typeof c.rejects === 'number' && c.rejects > 0) parts.push(soft(`打回 ${c.rejects} 次`, C.amber))
        if (isStr(c.causedBy) && c.causedBy !== '') parts.push(soft(`返工自 ${c.causedBy}`, C.red))
        return chips(parts)
      }

      // 卡片：自上而下分区——标签、标题、现状、要你、阻塞、操作
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
              {handoffButton(`handoff:${c.id}`, p, c)}
              {evidenceButton(`evidence:${c.id}`, proj.root, c)}
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
            <Button key="back" onPress={() => update($, open, () => '')} label="← 现在要我做的" />
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
            {waitingChips(s)}
            {liveChips(s)}
            {trust(p)}
            <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center">
              {act.isStale ? pill(act.text, C.red) : <Text size="caption" dimColor>{act.text}</Text>}
              <Text size="caption" dimColor>· {visitText(prev)} · 冻结 {s.frozen} · 遗留 {p.leftovers}</Text>
            </Box>
            <Link href={sessionLink(p.brain.id)} label={`→ 进入主脑会话：${p.brain.name}`} />
          </Box>

          {n >= 4 ? (
            <Box flexDirection="row" gap="sm" alignItems="flex-start">
              {COLS.map(c => columnView(c.key))}
            </Box>
          ) : (
            <Box flexDirection="column" gap="sm">
              <Box flexDirection="row" flexWrap="wrap" gap="xs">
                {COLS.map(c => (
                  <Button key={`tab:${c.key}`} variant={tab === c.key ? 'primary' : 'secondary'}
                    onPress={() => update($, colTab, () => c.key)} label={`${c.label} ${count(c.key)}`} />
                ))}
              </Box>
              {columnView((COLS.find(c => c.key === tab) ?? COLS[0]!).key)}
            </Box>
          )}

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
        </Box>
      )
    }

    // ---------- 第一屏：现在要我做的 ----------
    const queue = queueOf(projects, live)
    const ITEM_LABEL: Record<Item['kind'], [string, string]> = {
      waiting: ['等你批准', C.red],
      decide: ['等你拍板', C.red],
      act: ['等你动手', C.orange],
      delivered: ['新交付', C.green],
    }
    const itemView = (it: Item) => {
      const [label, color] = ITEM_LABEL[it.kind]
      const p = it.project.data
      const c = it.card
      const title = c?.title ?? '未登记到卡片的会话'
      const what =
        it.kind === 'waiting' ? '会话弹出了权限确认，停在那里等你' :
        it.kind === 'delivered' ? '已合入，看验证产物确认是不是你要的' :
        c?.ask ?? ''
      return (
        <Box key={`item:${it.key}`} flexDirection="column" padding="xs" gap="xs" backgroundColor={tint(color, 0.06)}>
          {chips([
            pill(label, color),
            ...(c?.priority != null ? [soft(`P${c.priority}`, PRIORITY_COLOR[c.priority] ?? C.grey)] : []),
          ])}
          <Text weight="semibold">{title}</Text>
          {what !== '' && <Text size="footnote">{what}</Text>}
          <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center">
            {it.kind === 'waiting' && it.session !== undefined && (
              <Button key={`go:${it.key}`} variant="primary" label="去这个会话 ›"
                onPress={() => void openUrl($, sessionLink(it.session!.id))} />
            )}
            {it.kind === 'delivered' && c !== undefined && evidenceButton(`ev:${it.key}`, it.project.root, c)}
            {(it.kind === 'decide' || it.kind === 'act') && c !== undefined && handoffButton(`handoff:${it.key}`, p, c, true)}
            {it.kind === 'delivered' && c !== undefined && handoffButton(`handoff:${it.key}`, p, c)}
            {it.ageMs !== undefined && (
              <Text size="caption" dimColor>{it.kind === 'delivered' ? `${ageText(it.ageMs)}前完成` : `已等 ${ageText(it.ageMs)}`}</Text>
            )}
          </Box>
        </Box>
      )
    }

    // 按项目分组；项目按登记顺序（queue 已按 等批准 > 拍板 > 动手 > 新交付、优先级、等待时长 排好组内顺序）
    const KIND_ORDER: Item['kind'][] = ['waiting', 'decide', 'act', 'delivered']
    const groups = projects
      .map(l => ({ l: l as Loaded & { data: Project }, items: queue.filter(it => it.project.key === l.key) }))
      .filter(g => g.items.length > 0)

    const n = perRow(width, TILE_MIN, 3)
    const visits = ((await $.store.get(VISITS)) ?? {}) as Record<string, number>

    // 项目块：标题行、阶段目标、进度、统计、等你、会话、信任指标、角注
    const tile = (l: Loaded) => {
      if (l.missing) {
        return (
          <Box key={`tile:${l.key}`} flexDirection="column" borderStyle="round" borderColor="promptBorder"
            padding="sm" gap="xs" width={pct(n)}>
            <Text size="heading" weight="bold">{l.key}</Text>
            {soft('还没迁移到卡片', C.grey)}
            <Text size="caption" dimColor>主脑下次被唤醒时用卡片命令建立</Text>
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
            <Text size="caption" dimColor>让主脑用卡片命令的 check 重新生成</Text>
          </Box>
        )
      }
      const p = l.data
      const s = stats(l as Loaded & { data: Project })
      const act = activityOf(l.activityMs)
      const youTotal = s.decide + s.act + s.waiting

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
          {waitingChips(s)}
          {liveChips(s)}
          {trust(p)}
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

    return (
      <Box flexDirection="column" gap="md" paddingX="xs">
        <Box flexDirection="column">
          <Text size="title" weight="bold">现在要我做的</Text>
          <Text size="caption" dimColor>
            只列有事等你的项目，按项目分组、位置固定。点“带去主脑”会跳到主脑会话并自动填好卡片内容。
          </Text>
        </Box>
        {groups.length === 0 ? (
          <Box padding="sm" borderStyle="round" borderColor={C.green}>
            <Text color={C.green} weight="semibold">没有等你的事</Text>
          </Box>
        ) : (
          <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="flex-start">
            {groups.map(g => (
              <Box key={`g:${g.l.key}`} width={pct(n)} flexDirection="column" borderStyle="round"
                borderColor={g.items.some(i => i.kind === 'waiting' || i.kind === 'decide') ? C.red : C.orange} padding="sm" gap="sm">
                <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap="xs">
                  <Text size="heading" weight="bold">{g.l.data.project}</Text>
                  {g.l.data.stage !== null && soft(g.l.data.stage, C.teal)}
                </Box>
                {chips(KIND_ORDER.filter(k => g.items.some(i => i.kind === k))
                  .map(k => soft(`${ITEM_LABEL[k][0]} ${g.items.filter(i => i.kind === k).length}`, ITEM_LABEL[k][1])))}
                {g.items.map(itemView)}
                <Box flexDirection="row" justifyContent="flex-end">
                  <Button key={`genter:${g.l.key}`} plain onPress={() => void enter($, g.l.key)} label="进入项目 ›" />
                </Box>
              </Box>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text size="heading" weight="bold">项目</Text>
          <Text size="caption" dimColor>项目按固定顺序排列，不按紧急程度重排。</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="flex-start">
          {projects.map(tile)}
        </Box>
      </Box>
    )
  })
}

const activityOf = (ms: number | undefined) => {
  if (ms === undefined) return { text: '主脑动静未知', isStale: false }
  const d = days(Date.now() - ms)
  if (d === 0) return { text: '主脑今天有动静', isStale: false }
  return { text: `主脑 ${d} 天没动`, isStale: d >= 5 }
}

const visitText = (ms: number) => {
  if (ms === 0) return '第一次来看'
  const h = Math.floor((Date.now() - ms) / HOUR)
  if (h < 1) return '刚来看过'
  if (h < 24) return `${h} 小时前来看过`
  return `${days(Date.now() - ms)} 天前来看过`
}
