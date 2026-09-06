import { dateRangeChunks } from './scheduling.ts'
import type { Task } from './types.ts'

export type DynamicSchoolPlanItem = {
  taskId: string
  scheduledDate: string
  planReason: Task['plannerReason']
  dueFrom: string | null
  dueTo: string | null
  assignedWorkerId: string | null
  plannerPriority: number | null
}

type PlannerError = { code?: string; message?: string }
type PlannerRow = Record<string, unknown>
type PlannerChunkResult = { data: PlannerRow[] | null; error: PlannerError | null }

export type DynamicPlanLoaderOptions = {
  from: string
  to: string
  loadChunk: (from: string, to: string) => Promise<PlannerChunkResult>
  sleep?: (milliseconds: number) => Promise<void>
  logError?: (message: string, context: { from: string; to: string; code: string; message: string }) => void
}

const retryDelays = [300, 800] as const

export function isMissingDynamicPlanner(error: PlannerError | null) {
  return Boolean(error && ['42883', 'PGRST202'].includes(error.code ?? ''))
}

function isPermanentPlannerError(error: PlannerError) {
  const code = error.code ?? ''
  return code === '42501'
    || code === 'PGRST301'
    || code === 'PGRST302'
    || /^22/.test(code)
    || /^23/.test(code)
    || /^42/.test(code)
    || /^PGRST2/.test(code)
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds))

/**
 * Načte týdenní RPC chunky sekvenčně. Serverový RPC zůstává jediným zdrojem
 * plánu; tato vrstva pouze omezuje souběh, opakuje dočasné chyby a slučuje řádky.
 */
export async function loadDynamicSchoolPlan({
  from,
  to,
  loadChunk,
  sleep = defaultSleep,
  logError = (message, context) => console.error(message, context),
}: DynamicPlanLoaderOptions): Promise<Map<string, Map<string, DynamicSchoolPlanItem>> | null> {
  const byDate = new Map<string, Map<string, DynamicSchoolPlanItem>>()

  for (const chunk of dateRangeChunks(from, to)) {
    let result: PlannerChunkResult | null = null
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      result = await loadChunk(chunk.from, chunk.to)
      if (!result.error) break
      if (isMissingDynamicPlanner(result.error)) return null

      const finalAttempt = attempt === retryDelays.length
      const permanent = isPermanentPlannerError(result.error)
      if (finalAttempt || permanent) {
        logError('Část plánu úklidu se nepodařilo načíst.', {
          from: chunk.from,
          to: chunk.to,
          code: result.error.code ?? 'unknown',
          message: result.error.message ?? 'Neznámá chyba',
        })
        throw result.error
      }
      await sleep(retryDelays[attempt])
    }

    const rows = result?.data ?? []
    if (rows.length >= 1000) {
      throw new Error('Dynamický plán překročil bezpečný limit načtení. Zkuste načtení zopakovat.')
    }
    for (const row of rows) {
      const date = String(row.scheduled_date)
      const taskId = String(row.task_id)
      const items = byDate.get(date) ?? new Map<string, DynamicSchoolPlanItem>()
      items.set(taskId, {
        taskId,
        scheduledDate: date,
        planReason: (row.plan_reason as DynamicSchoolPlanItem['planReason']) ?? null,
        dueFrom: (row.due_from as string | null) ?? null,
        dueTo: (row.due_to as string | null) ?? null,
        assignedWorkerId: (row.assigned_worker_id as string | null) ?? null,
        plannerPriority: row.planner_priority == null ? null : Number(row.planner_priority),
      })
      byDate.set(date, items)
    }
  }

  return byDate
}
