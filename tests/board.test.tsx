import { expect, test } from 'claude-code/testing'

const REG = {
  projects: [
    { key: 'demo', file: '/x/demo.json', activity: '/x/ledger.md' },
    { key: 'fresh', file: '/y/missing.json', activity: '/y/ledger.md' },
    { key: 'broken', file: '/z/broken.json', activity: '/z/ledger.md' },
  ],
}
const PROJECT = {
  project: '演示项目', stage: '内测', stageGoal: '跑通全流程',
  brain: { name: '演示主脑', id: 'local_abc' }, leftovers: 5,
  cards: [
    { id: 'a', title: '定方案', column: 'todo', kind: '决策', priority: 1, milestone: true, ball: 'you', ask: '拍板方案', askKind: 'decide', now: '三个选项', blocked: '', since: '2026-11-01', doneAt: null },
    { id: 'b', title: '入金实测', column: 'todo', kind: '事务', priority: 2, milestone: true, ball: 'you', ask: '入一笔小额资金', askKind: 'act', now: '', blocked: '对方提测', since: null, doneAt: null },
    { id: 'c', title: '必补代码', column: 'doing', kind: '功能', priority: 1, milestone: true, ball: 'brain', ask: '', askKind: null, now: '实施中', blocked: '', since: null, doneAt: null },
    { id: 'd', title: '上测试服', column: 'done', kind: '功能', priority: null, milestone: true, ball: 'brain', ask: '', askKind: null, now: '', blocked: '', since: null, doneAt: null },
  ],
}

const pane = (bodyColumns: number) =>
  ({
    plugin: 'orchestrator', component: 'Pane', requestId: 'board',
    props: { title: '项目看板', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  }) as const

test('总览按项目显示，点项目进入单项目看板再返回', async ($, on) => {
  let store: unknown = undefined
  on('fs.read', (_, e) => {
    const path = String((e as { path?: unknown }).path ?? '')
    if (path.endsWith('projects.json')) return { value: JSON.stringify(REG) }
    if (path.endsWith('demo.json')) return { value: JSON.stringify(PROJECT) }
    if (path.endsWith('broken.json')) return { value: JSON.stringify({ ...PROJECT, cards: [{ ...PROJECT.cards[0], column: '待办' }] }) }
    return { value: '' }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_, e) => {
    if (String((e as { path?: unknown }).path ?? '').endsWith('missing.json')) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: Date.now() } }
  })
  on('store.get', () => ({ value: store }))
  on('store.set', (_, e) => {
    store = (e as { value?: unknown }).value
    return { value: undefined }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const width of [40, 70, 140]) {
      const ui = await $.ui.mount({ ...pane(width), surface })
      expect((await ui.find({ type: 'Text', text: /拍板 1/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /阶段目标 1\/4/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Button', label: /进入项目/ }))).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /还没迁移到卡片/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /卡片文件格式不合格/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /列 待办 不认识/ }))?.text).toBeTruthy()

      await ui.press({ key: 'enter:demo' })
      expect((await ui.find({ type: 'Text', text: /^拍板方案$/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /^对方提测$/ }))?.text).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /遗留小项 5 件/ }))?.text).toBeTruthy()

      await ui.press({ key: 'back' })
      expect((await ui.find({ type: 'Text', text: /^项目看板$/ }))?.text).toBeTruthy()
      await ui.unmount()
    }
  }
})

test('卡片“带去主脑”：复制卡片内容并跳到主脑会话', async ($, on) => {
  on('fs.read', (_, e) => {
    const path = String((e as { path?: unknown }).path ?? '')
    if (path.endsWith('projects.json')) return { value: JSON.stringify({ projects: [REG.projects[0]] }) }
    if (path.endsWith('demo.json')) return { value: JSON.stringify(PROJECT) }
    return { value: '' }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: Date.now() } }))
  let store: unknown = undefined
  on('store.get', () => ({ value: store }))
  on('store.set', (_, e) => {
    store = (e as { value?: unknown }).value
    return { value: undefined }
  })
  const runs: { argv: readonly string[]; stdin?: string; lang?: string }[] = []
  on('process.run', (_, e) => {
    const { argv, init } = e as { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string> } }
    runs.push({ argv, stdin: init?.stdin, lang: init?.env?.LANG })
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...pane(140), surface: 'desktop' })
  await ui.press({ key: 'enter:demo' })
  expect(await ui.find({ type: 'Button', label: /带去主脑/ })).toBeTruthy()
  await ui.press({ key: 'handoff:a' })
  for (let i = 0; i < 50 && toasts.length === 0; i++) await new Promise(r => setTimeout(r, 10))

  const copy = runs.find(r => r.argv[0] === 'pbcopy')
  expect(copy?.stdin).toContain('关于看板卡片「定方案」（演示项目，卡片编号 a）')
  expect(copy?.stdin).toContain('- 状态：待办，决策，P1，阶段目标')
  expect(copy?.stdin).toContain('- 现状：三个选项')
  expect(copy?.stdin).toContain('- 等我拍板：拍板方案')
  expect(copy?.stdin).toContain('我的指示：')
  expect(copy?.lang).toContain('UTF-8')
  expect(runs.find(r => r.argv[0] === 'open')?.argv[1]).toBe('claude://claude.ai/epitaxy/local_abc')
  expect(toasts[0]).toContain('⌘V')
  await ui.unmount()
})
