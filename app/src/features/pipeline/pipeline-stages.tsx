import type { IngestionStage, IngestionStageId } from './types'
import { AlertCircle, CheckCircle2, Circle, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { ingestionSteps } from './ingestion-steps'

export function PipelineStages({ stages, pending, failed, unconfirmed, interrupted, failureMessage }: { stages: Partial<Record<IngestionStageId, IngestionStage>>, pending: boolean, failed: boolean, unconfirmed: boolean, interrupted?: boolean, failureMessage?: string }) {
  const [selected, setSelected] = useState<IngestionStageId | null>(null)
  const latest = [...ingestionSteps].reverse().find(step => stages[step.id])?.id ?? 'normalize'
  const selectedId = selected ?? latest
  const definition = ingestionSteps.find(step => step.id === selectedId)!
  const stage = stages[selectedId]
  const completed = Object.values(stages).filter(item => item.status === 'completed').length
  const status = (item: IngestionStage | undefined) => {
    if (!item)
      return unconfirmed ? '未收到状态' : failed ? '未执行' : '等待处理'
    if (item.status === 'completed')
      return '已完成'
    if (item.status === 'failed')
      return interrupted ? '已中断' : '失败'
    return pending ? '处理中' : interrupted ? '已中断' : '状态未确认'
  }

  return (
    <section className="pipeline-stages" aria-label="入库阶段与产物">
      <div className="panel-heading">
        <h2>阶段与产物</h2>
        <span role="status" aria-live="polite">
          {pending ? `${ingestionSteps.find(step => step.id === latest)?.name} · 处理中` : unconfirmed ? '入库状态未确认' : interrupted ? '已中断，可继续' : failed ? '处理未完成' : completed === ingestionSteps.length ? '全部完成' : '等待导入'}
          {' · '}
          {completed}
          {' / '}
          {ingestionSteps.length}
        </span>
      </div>
      <div className="stage-workspace">
        <nav className="stage-navigation" aria-label="选择入库阶段">
          {ingestionSteps.map((step, index) => {
            const item = stages[step.id]
            const Icon = item?.status === 'completed' ? CheckCircle2 : item?.status === 'failed' ? AlertCircle : item?.status === 'running' && pending ? LoaderCircle : Circle
            return (
              <button key={step.id} type="button" className={`stage-button ${item?.status ?? 'waiting'}`} aria-pressed={selectedId === step.id} onClick={() => setSelected(step.id)}>
                <span className="stage-order">{String(index + 1).padStart(2, '0')}</span>
                <span className="stage-name">
                  <strong>{step.name}</strong>
                  <small>
                    {item?.reused ? '已完成 · 复用检查点' : status(item)}
                    {item?.progress && ` · ${item.progress.completed}/${item.progress.total} 章节`}
                    {item && item.status !== 'running' && ` · ${(item.durationMs / 1000).toFixed(2)} 秒`}
                  </small>
                </span>
                <Icon size={16} className={item?.status === 'running' && pending ? 'animate-spin' : undefined} />
              </button>
            )
          })}
        </nav>
        <div className="stage-inspector" key={selectedId}>
          <div className="stage-inspector-heading">
            <div>
              <span className="step-code">{definition.code}</span>
              <h3>{definition.name}</h3>
            </div>
            <div className="stage-inspector-actions">
              {pending && selected && <button type="button" onClick={() => setSelected(null)}>跟随当前阶段</button>}
              <span className={`stage-status ${stage?.status ?? ''}`}>{status(stage)}</span>
            </div>
          </div>
          <p className="stage-description">{definition.description}</p>
          {stage?.preview
            ? (
                <>
                  <dl className="stage-metrics">
                    {stage.preview.metrics.map(metric => (
                      <div key={metric.label}>
                        <dt>{metric.label}</dt>
                        <dd>{metric.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {stage.preview.totalItems > 0 && (
                    <div className="stage-output">
                      <p className="field-hint">
                        展示
                        {' '}
                        {stage.preview.items.length}
                        {' '}
                        /
                        {' '}
                        {stage.preview.totalItems}
                        {' '}
                        项产物；每项最多预览 6,000 字符。
                      </p>
                      {stage.preview.items.map((item, index) => (
                        <details className="stage-output-item" key={item.id} open={index === 0}>
                          <summary>{item.title}</summary>
                          <pre>{item.text}</pre>
                          {item.truncated && <p className="field-hint">此项预览已截取，实际入库使用完整内容。</p>}
                        </details>
                      ))}
                    </div>
                  )}
                  {stage.preview.totalItems === 0 && <p className="field-hint">{selectedId === 'wiki' ? '本次未提取到实体或概念，没有生成 Wiki 节点。原文片段仍可参与检索。' : '此阶段以数量和模型信息展示结果。'}</p>}
                </>
              )
            : (
                <div className="stage-placeholder">
                  <p>{stage?.status === 'failed' ? failureMessage ?? '此阶段失败，后续阶段未执行。已完成阶段的预览仍可查看。' : stage?.status === 'running' ? pending ? '正在处理，完成后显示本阶段产物。' : interrupted ? '处理已中断，已完成的章节已保存。继续重试将复用这些结果。' : '进度连接已中断，最后收到的状态为处理中。可继续重试，服务端会复用已经保存的结果。' : '本阶段完成后，可在这里查看真实产物。'}</p>
                  {stage?.progress && (
                    <strong>
                      已提取
                      {stage.progress.completed}
                      {' '}
                      /
                      {stage.progress.total}
                      {' '}
                      个章节
                    </strong>
                  )}
                </div>
              )}
        </div>
      </div>
      <p className="field-hint stage-session-note">完成的阶段和章节会保存到服务端；中断后可继续，刷新页面也可恢复最近任务。</p>
    </section>
  )
}
