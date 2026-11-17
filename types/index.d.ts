export type Column = 'todo' | 'doing' | 'verify' | 'done' | 'frozen'

export type Ball = 'you' | 'external' | 'brain'

export type Card = {
  id: string
  title: string
  column: Column
  kind: string
  priority: 1 | 2 | 3 | null
  milestone: boolean
  ball: Ball
  ask: string
  askKind: 'decide' | 'act' | null
  now: string
  blocked: string
  since: string | null
  doneAt: string | null
  // 主脑自用的详情，看板不显示
  detail?: string
  // 验收打回次数；没打回过可以不写
  rejects?: number
  // 缺陷卡专用：合入后才发现的问题，指向引入它的卡
  causedBy?: string
}

export type Project = {
  project: string
  stage: string | null
  stageGoal: string | null
  brain: { name: string; id: string }
  leftovers: number
  cards: Card[]
}

export type RegistryEntry = { key: string; file: string; activity: string }

export type Registry = { projects: RegistryEntry[] }

declare module 'claude-code' {
  interface PluginState {
    orchestrator: {
      open: string
      col: string
      showActs: boolean
      showFrozen: boolean
      prevVisit: number
      rev: number
    }
  }
}
