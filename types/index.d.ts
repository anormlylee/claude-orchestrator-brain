export type Column = 'todo' | 'doing' | 'verify' | 'done' | 'frozen'

export type Ball = 'you' | 'external' | 'brain'

// cards.json 由 board/card.py 根据 events.jsonl 生成，格式见 board/cards-format.md
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
  // 验收打回次数
  rejects?: number
  // 缺陷卡专用：合入后才发现的问题，指向引入它的卡
  causedBy?: string
  // 这张卡对应的会话（桌面版会话编号）
  sessions?: string[]
  // 验证产物路径（相对项目根目录或绝对路径）
  evidence?: string
  // 主脑请用户看：看板首屏“待你看”只收这类
  review?: boolean
  // 决策卡的审批状态：pending 待审、approved 通过、vetoed 否决
  approval?: Approval
  // 通过的依据（用户原话）或否决原因
  approvalNote?: string
  // 审批日期
  approvalAt?: string
}

export type Approval = 'pending' | 'approved' | 'vetoed'

export type Window = { since: string; done: number; rejects: number; rework: number; dispatched: number }

export type Project = {
  project: string
  stage: string | null
  stageGoal: string | null
  brain: { name: string; id: string }
  leftovers: number
  cards: Card[]
  // 已经下板、但审批过（通过或否决）的决策卡：按审批状态筛选时要查得到
  decided?: Card[]
  stats?: { week: Window; stage?: Window }
}

export type RegistryEntry = { key: string; file: string; activity: string; root?: string }

export type Registry = { projects: RegistryEntry[] }

// board/live.sh 写的会话实况
export type LiveState = 'running' | 'waiting' | 'idle' | 'error' | 'started'
export type LiveSession = { id: string; state: LiveState; at: number; project: string }

declare module 'claude-code' {
  interface PluginState {
    orchestrator: {
      open: string
      col: string
      showFrozen: boolean
      // 第一屏各项目的展开状态：没记录时按“有没有要你批准或拍板的事”自动决定
      fold: Record<string, 'open' | 'closed' | 'all'>
      // 项目页已完成列是否显示全部
      showAllDone: boolean
      // 项目页按审批状态筛选：all 全部卡片，其余只看该审批状态的决策卡
      approvalTab: string
      prevVisit: number
      rev: number
    }
  }
}
