"""用本机 6 个项目的真实卡片（副本，经新版 card.py check 生成）渲染看板，导出渲染树。"""
import json, os, sys, shutil, glob, time
S, W = sys.argv[1], sys.argv[2]
mod = os.path.join(S, 'shot', 'mod')
shutil.rmtree(mod, ignore_errors=True)
os.makedirs(os.path.join(mod, 'tests'))
for d in ('.claude-plugin', 'hooks', 'types'):
    shutil.copytree(os.path.join(W, d), os.path.join(mod, d))
reg_path = os.path.expanduser('~/.claude/board/projects.json')
reg = json.load(open(reg_path))
files, stats = {'/h/.claude/board/projects.json': json.dumps(reg)}, {}
for p in reg['projects']:
    copy = os.path.join(S, 'real', p['key'], 'docs', 'brain', 'cards.json')
    files[p['file']] = open(copy, encoding='utf-8').read()
    for f in (p['file'], p['activity']):
        try:
            stats[f] = os.stat(f).st_mtime * 1000
        except OSError:
            pass
live = {}
for f in glob.glob(os.path.expanduser('~/.claude/board/live/*.json')):
    try:
        live[os.path.basename(f)] = json.load(open(f))
    except Exception:
        pass
test = """import { mock, test } from 'claude-code/testing'
const FILES: Record<string, string> = %s
const STATS: Record<string, number> = %s
const LIVE: Record<string, object> = %s
const NOW = %d
test('render', { timeoutMs: 120000 }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/h', CLAUDE_CODE_HOST_SESSION_ID: 'local_none' })
  on('fs.read', (_, e) => {
    const path = String((e as { path?: unknown }).path ?? '')
    if (FILES[path] !== undefined) return { value: FILES[path] }
    const name = path.split('/').pop() ?? ''
    if (path.includes('/board/live/') && LIVE[name]) return { value: JSON.stringify(LIVE[name]) }
    throw new Error('ENOENT')
  })
  on('fs.list', (_, e) => {
    const path = String((e as { path?: unknown }).path ?? '')
    if (path.endsWith('/board/live')) return { value: Object.keys(LIVE).map(name => ({ name, kind: 'file', size: 1, mtimeMs: NOW })) } as never
    return { value: [] } as never
  })
  on('fs.stat', (_, e) => {
    const path = String((e as { path?: unknown }).path ?? '')
    if (STATS[path] === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: STATS[path], isLink: false } }
  })
  on('fs.exists', () => ({ value: false }))
  const ui = await $.ui.mount({ plugin: 'orchestrator', component: 'Pane', requestId: 'board', surface: 'desktop',
    props: { title: '项目看板', isFocused: false, bodyColumns: %d, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as never)
  const dump = async (name: string) => console.log('@@TREE ' + name + ' ' + JSON.stringify(await ui.drawn()))
  await dump('home')
  await ui.press({ key: 'enter:novel' })
  await dump('novel-all')
  await ui.press({ key: 'appr:pending' })
  await dump('novel-pending')
  await ui.press({ key: 'appr:approved' })
  await dump('novel-approved')
  await ui.press({ key: 'appr:vetoed' })
  await dump('novel-vetoed')
})
""" % (json.dumps(files, ensure_ascii=False), json.dumps(stats), json.dumps(live, ensure_ascii=False), int(time.time() * 1000), int(sys.argv[3]))
open(os.path.join(mod, 'tests', 'render.test.tsx'), 'w', encoding='utf-8').write(test)
