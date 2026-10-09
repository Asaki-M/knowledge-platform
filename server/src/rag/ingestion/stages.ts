import type { IngestionCheckpointStore } from './checkpoints.js'

export type IngestionStageId = 'normalize' | 'sections' | 'chunks' | 'enrichment' | 'wiki' | 'indexing' | 'embedding' | 'storage'

export interface StagePreviewItem {
  id: string
  title: string
  text: string
  truncated: boolean
}

export interface StagePreview {
  metrics: { label: string, value: string | number }[]
  items: StagePreviewItem[]
  totalItems: number
}

export interface IngestionStageEvent {
  id: IngestionStageId
  status: 'running' | 'completed' | 'failed'
  durationMs: number
  /** 从本任务检查点恢复的已完成阶段，不重复调用模型。 */
  reused?: boolean
  progress?: { completed: number, total: number }
  preview?: StagePreview
}

export type IngestionObserver = (event: IngestionStageEvent) => Promise<void>

/** 预览只复制有限文本，不修改用于入库的完整产物，不传输 AST 或向量数组。 */
export function stagePreview(metrics: StagePreview['metrics'], items: { id: string, title: string, text: string }[] = []): StagePreview {
  return {
    metrics,
    totalItems: items.length,
    items: items.slice(0, 20).map(item => ({ ...item, title: item.title.slice(0, 300), text: item.text.slice(0, 6000), truncated: item.text.length > 6000 })),
  }
}

export function createStageReporter(observer?: IngestionObserver, checkpoint?: IngestionCheckpointStore) {
  let current: IngestionStageId | undefined
  let started = 0
  let progress: IngestionStageEvent['progress']
  const emit = async (event: Omit<IngestionStageEvent, 'id' | 'durationMs'>) => {
    if (current)
      await observer?.({ id: current, durationMs: Math.round(performance.now() - started), ...(progress ? { progress } : {}), ...event })
  }
  return {
    async run<T>(id: IngestionStageId, action: () => T | Promise<T>, preview: (value: T) => StagePreview): Promise<T> {
      current = id
      started = performance.now()
      progress = undefined
      await emit({ status: 'running' })
      try {
        const saved = await checkpoint?.load<T>(`stage:${id}`)
        const reused = saved !== undefined
        const value = reused ? saved : await action()
        if (!reused)
          await checkpoint?.save(`stage:${id}`, value)
        await emit({ status: 'completed', ...(reused ? { reused: true } : {}), ...(observer ? { preview: preview(value) } : {}) })
        return value
      }
      catch (error) {
        await emit({ status: 'failed' })
        throw error
      }
    },
    progress: (completed: number, total: number) => {
      progress = { completed, total }
      return emit({ status: 'running' })
    },
  }
}
