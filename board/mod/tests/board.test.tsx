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
    plugin: 'board', component: 'Pane', requestId: 'board',
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
