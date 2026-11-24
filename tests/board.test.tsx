import { expect, mock, test } from 'claude-code/testing'

const HOME = '/h'
// 每个用例要挂载多次界面，机器忙时默认的 5 秒不够
const SLOW = { timeoutMs: 60_000 }
const NOW = Date.now()
// 待你看只留 7 天：交付日期跟着今天走，用例才不会过期
const TODAY = new Date(NOW).toISOString().slice(0, 10)
const REG = {
  projects: [
    { key: 'demo', file: '/x/repo/docs/brain/cards.json', activity: '/x/repo/docs/brain/ledger.md' },
    { key: 'fresh', file: '/y/missing.json', activity: '/y/ledger.md' },
    { key: 'broken', file: '/z/broken.json', activity: '/z/ledger.md' },
  ],
}
const W = { since: '2026-11-11', done: 2, rejects: 3, rework: 1, dispatched: 4 }
const PROJECT = {
  project: '演示项目', stage: '内测', stageGoal: '跑通全流程',
  brain: { name: '演示主脑', id: 'local_brain' }, leftovers: 5,
  stats: { week: W, stage: { ...W, since: '2026-11-01' } },
  cards: [
    { id: 'a', title: '定方案', column: 'todo', kind: '决策', priority: 1, milestone: true, ball: 'you', ask: '拍板方案', askKind: 'decide', now: '三个选项', blocked: '', since: '2026-11-01', doneAt: null },
    { id: 'b', title: '入金实测', column: 'todo', kind: '事务', priority: 2, milestone: true, ball: 'you', ask: '入一笔小额资金', askKind: 'act', now: '', blocked: '对方提测', since: null, doneAt: null },
    { id: 'c', title: '必补代码', column: 'doing', kind: '功能', priority: 1, milestone: true, ball: 'brain', ask: '', askKind: null, now: '实施中', blocked: '', since: '2026-11-10', doneAt: null, rejects: 2, sessions: ['local_run'] },
    { id: 'f', title: '老分支', column: 'doing', kind: '功能', priority: 2, milestone: false, ball: 'brain', ask: '', askKind: null, now: '实施中', blocked: '', since: '2026-11-10', doneAt: null, sessions: ['local_stuck'] },
    { id: 'd', title: '上测试服', column: 'done', kind: '功能', priority: null, milestone: true, ball: 'brain', ask: '', askKind: null, now: '已合入', blocked: '', since: TODAY, doneAt: TODAY, evidence: '.local/evidence/d/', review: true },
    // 只填了产物、没请用户看的，不进首屏
    { id: 'g', title: '中文化修补', column: 'done', kind: '缺陷', priority: null, milestone: false, ball: 'brain', ask: '', askKind: null, now: '已合入', blocked: '', since: '2026-11-16', doneAt: '2026-11-16', evidence: 'docs/log.md' },
    ...[1, 2, 3, 4, 5].map(i => ({ id: `old${i}`, title: `旧事${i}`, column: 'done', kind: '事务', priority: null, milestone: false, ball: 'brain', ask: '', askKind: null, now: '已合入', blocked: '', since: '2026-11-0' + i, doneAt: '2026-11-0' + i })),
    { id: 'e', title: '首页白屏', column: 'todo', kind: '缺陷', priority: 1, milestone: false, ball: 'brain', ask: '', askKind: null, now: '待修', blocked: '', since: '2026-11-16', doneAt: null, causedBy: 'd' },
  ],
}
const LIVE: Record<string, object> = {
  'local_run.json': { id: 'local_run', state: 'running', at: NOW / 1000 - 30, project: '/x/repo' },
  'local_stuck.json': { id: 'local_stuck', state: 'idle', at: NOW / 1000 - 5 * 3600, project: '/x/repo' },
  'local_ask.json': { id: 'local_ask', state: 'waiting', at: NOW / 1000 - 600, project: '/x/repo/.claude/worktrees/w1' },
  'local_other.json': { id: 'local_other', state: 'waiting', at: NOW / 1000 - 60, project: '/elsewhere' },
}

const pane = (bodyColumns: number) =>
  ({
    plugin: 'orchestrator', component: 'Pane', requestId: 'board',
    props: { title: '项目看板', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  }) as const

type Run = { argv: readonly string[]; stdin?: string; lang?: string }

function world(on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, string>, project: object = PROJECT) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME, CLAUDE_CODE_HOST_SESSION_ID: 'local_brain' })
  on('fs.read', (_, e) => {
    const path = String((e as { path?: unknown }).path ?? '')
    if (path === `${HOME}/.claude/board/projects.json`) return { value: JSON.stringify(REG) }
    if (path.endsWith('repo/docs/brain/cards.json')) return { value: JSON.stringify(project) }
    if (path.endsWith('broken.json')) return { value: JSON.stringify({ ...PROJECT, cards: [{ ...PROJECT.cards[0], column: '待办' }] }) }
    const name = path.split('/').pop() ?? ''
    if (path.includes('/board/live/') && LIVE[name]) return { value: JSON.stringify(LIVE[name]) }
    if (files[path] !== undefined) return { value: files[path] }
    throw new Error('ENOENT')
  })
  on('fs.list', (_, e) => {
    const path = String((e as { path?: unknown }).path ?? '')
    if (path.endsWith('/board/live')) return { value: Object.keys(LIVE).map(name => ({ name, kind: 'file', size: 1, mtimeMs: NOW })) }
    return { value: [] }
  })
  on('fs.stat', (_, e) => {
    if (String((e as { path?: unknown }).path ?? '').endsWith('missing.json')) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: NOW, isLink: false } }
  })
  on('fs.exists', (_, e) => ({ value: files[String((e as { path?: unknown }).path ?? '')] !== undefined }))
  on('fs.write', (_, e) => {
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined }
  })
  const runs: Run[] = []
  on('process.run', (_, e) => {
    const { argv, init } = e as { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string> } }
    runs.push({ argv, stdin: init?.stdin, lang: init?.env?.LANG })
    if (argv[0] === 'rm') delete files[argv[2] ?? '']
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  return { runs, toasts, clock }
}

test('第一屏是项目清单：有会话等你批准或有待审的项目自动展开前几件，项目页带会话实况和信任指标', SLOW, async ($, on) => {
  world(on, {})
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const width of [40, 140]) {
      const ui = await $.ui.mount({ ...pane(width), surface })
      expect((await ui.find({ type: 'Text', text: /^项目$/ }))?.text).toBeTruthy()
      // 演示项目有等你批准和拍板：自动展开，先列 3 件（批准、拍板、动手），待你看折在“还有 1 件”里
      expect((await ui.find({ type: 'Text', text: /等你批准 1/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /待你看 1/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /会话弹出了权限确认/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Button', label: /去这个会话/ }))).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /^拍板方案$/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /^入一笔小额资金$/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /已等 10 分钟/ }))?.text).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /主脑请你看验证产物/ })).toBeFalsy()
      expect(await ui.find({ type: 'Text', text: /^中文化修补$/ })).toBeFalsy()
      // 项目行上的会话状态
      expect((await ui.find({ type: 'Text', text: /● 在跑 1/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /会话停滞 1/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /还没迁移到卡片/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /列 待办 不认识/ }))?.text).toBeTruthy()

      await ui.press({ key: 'enter:demo' })
      expect((await ui.find({ type: 'Text', text: /遗留小项 5 件/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /会话等你批准 1/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /打回 3/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /返工 1/ }))?.text).toBeTruthy()
      await ui.press({ key: 'tab:doing' }).catch(() => undefined)
      expect((await ui.find({ type: 'Text', text: /会话在跑/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /会话停了 5 小时/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /打回 2 次/ }))?.text).toBeTruthy()

      await ui.press({ key: 'back' })
      expect((await ui.find({ type: 'Text', text: /^项目$/ }))?.text).toBeTruthy()
      await ui.unmount()
    }
  }
})

test('展开收起、看过了、已完成列折叠', SLOW, async ($, on) => {
  world(on, {})
  const ui = await $.ui.mount({ ...pane(140), surface: 'desktop' })
  await ui.press({ key: 'more:demo' })
  expect((await ui.find({ type: 'Text', text: /主脑请你看验证产物/ }))?.text).toBeTruthy()
  // 看过了：记在本机，首屏不再出现
  await ui.press({ key: 'seen:r:demo:d' })
  expect(await ui.find({ type: 'Text', text: /待你看/ })).toBeFalsy()
  // 收起后只剩项目行
  await ui.press({ key: 'fold:demo' })
  expect(await ui.find({ type: 'Text', text: /^拍板方案$/ })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /待审 1/ }))?.text).toBeTruthy()
  await ui.press({ key: 'fold:demo' })
  expect((await ui.find({ type: 'Text', text: /^拍板方案$/ }))?.text).toBeTruthy()
  // 项目页已完成列：7 件只先显示最近 5 件
  await ui.press({ key: 'enter:demo' })
  expect((await ui.find({ type: 'Button', label: /更早的 2 件/ }))).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^旧事1$/ })).toBeFalsy()
  await ui.press({ key: 'done-more' })
  expect((await ui.find({ type: 'Text', text: /^旧事1$/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('带去主脑：留下待填内容、复制兜底、跳转；主脑会话读到后填进输入框', SLOW, async ($, on) => {
  const files: Record<string, string> = {}
  const { runs, toasts, clock } = world(on, files)
  let box = ''
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', (_, e) => {
    const { text, mode } = e as { text: string; mode?: string }
    box = mode === 'append' ? box + text : text
    return { isFilled: true }
  })

  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }))
  on('command.register', () => ({ value: {} }))
  await $.session.start({ cwd: '/x/repo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...pane(140), surface: 'desktop' })
  await ui.press({ key: 'handoff:c:demo:a' })

  const pending = files[`${HOME}/.claude/board/pending/local_brain.json`]
  expect(pending).toBeTruthy()
  const text = (JSON.parse(pending ?? '{}') as { text: string }).text
  expect(text).toContain('关于看板卡片「定方案」（演示项目，卡片编号 a）')
  expect(text).toContain('- 状态：待办，决策，待审，P1，阶段目标')
  expect(text).toContain('- 待我审：拍板方案')
  expect(text).toContain('我的指示：')
  expect(runs.find(r => r.argv[0] === 'pbcopy')?.lang).toContain('UTF-8')
  expect(runs.find(r => r.argv[0] === 'open')?.argv[1]).toBe('claude://claude.ai/epitaxy/local_brain')
  expect(toasts.at(-1)).toContain('自动填进输入框')

  // 本测试的会话就是 local_brain：时钟走 2 秒，内容填进输入框，待填文件删掉
  await clock.advance(2000)
  expect(box).toBe(text)
  expect(files[`${HOME}/.claude/board/pending/local_brain.json`]).toBeUndefined()
  expect(toasts.at(-1)).toContain('填进输入框')
  await ui.unmount()
})

// 决策卡的审批状态：旧文件没有 approval 字段的、没完成的决策卡也算待审
const dec = (id: string, title: string, extra: object) => ({
  id, title, kind: '决策', priority: null, milestone: false, ball: 'brain', ask: '', askKind: null, now: '已定', blocked: '',
  since: '2026-11-16', doneAt: '2026-11-16', column: 'done', ...extra,
})
const WITH_APPROVAL = {
  ...PROJECT,
  cards: [
    ...PROJECT.cards,
    dec('p2', '宫门谁守', { column: 'todo', priority: 3, doneAt: null, now: '推荐，暂按此写' }),
    dec('fz', '冻结的旧决策', { column: 'frozen', doneAt: null, now: '先放着' }),
    dec('ok', '用哪家云', { approval: 'approved', approvalNote: 'lee：就按推荐', approvalAt: '2026-11-16' }),
    dec('no', '协议费口径', { approval: 'vetoed', approvalNote: '费率太高', approvalAt: '2026-11-15' }),
  ],
  decided: [dec('old', '三个月前的决策', { approval: 'approved', approvalAt: '2026-08-01', doneAt: '2026-08-01', since: '2026-08-01' })],
}

test('审批状态：首屏待审计数，项目页按待审、通过、否决筛选，已下板的审批记录也查得到', SLOW, async ($, on) => {
  world(on, {}, WITH_APPROVAL)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(140), surface })
    // 首屏：定方案（球在你）+ 宫门谁守（没完成的决策卡）= 待审 2；冻结的不算
    expect((await ui.find({ type: 'Text', text: / 待审 2 /}))?.text).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /等用户|等你拍板/ })).toBeFalsy()

    await ui.press({ key: 'enter:demo' })
    // 全部卡片视图：通过、否决的卡在已完成列，带审批色块和结论
    expect((await ui.find({ type: 'Button', label: /^待审 2$/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Button', label: /^通过 2$/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Button', label: /^否决 1$/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^ 待审 $/ }))?.text).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^三个月前的决策$/ })).toBeFalsy()

    await ui.press({ key: 'appr:pending' })
    expect((await ui.find({ type: 'Text', text: /还没定，等你审/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^定方案$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^宫门谁守$/ }))?.text).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^冻结的旧决策$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /^必补代码$/ })).toBeFalsy()

    await ui.press({ key: 'appr:approved' })
    expect((await ui.find({ type: 'Text', text: /^用哪家云$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^三个月前的决策$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /lee：就按推荐/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /✓ 通过 · 2026-11-16/ }))?.text).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^定方案$/ })).toBeFalsy()

    await ui.press({ key: 'appr:vetoed' })
    expect((await ui.find({ type: 'Text', text: /原因：费率太高/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /✗ 否决/ }))?.text).toBeTruthy()

    await ui.press({ key: 'appr:all' })
    expect((await ui.find({ type: 'Text', text: /● 待办/ }))?.text).toBeTruthy()
    // 重新进项目时回到全部卡片
    await ui.press({ key: 'appr:vetoed' })
    await ui.press({ key: 'back' })
    await ui.press({ key: 'enter:demo' })
    expect((await ui.find({ type: 'Text', text: /● 待办/ }))?.text).toBeTruthy()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})
