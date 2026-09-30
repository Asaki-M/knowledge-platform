import type { LogModel, OperationLog } from './types'

function ModelSummary({ label, models }: { label: string, models: LogModel[] }) {
  if (!models.length)
    return null
  // 任一条记录未报告用量时，不把剩余用量冒充完整汇总。
  const completeUsage = models.every(model => model.usage != null)
  const names = [...new Set(models.map(model => `${model.provider} / ${model.model ?? '默认模型'}`))]
  return (
    <div className="model-summary">
      <div className="panel-heading">
        <h3>{label}</h3>
        <span>
          {models.length}
          {' '}
          条记录
        </span>
      </div>
      {names.map(name => <p key={name}>{name}</p>)}
      {models[0]?.dimensions != null && (
        <small>
          向量维度：
          {models[0].dimensions}
        </small>
      )}
      {completeUsage
        ? (
            <dl className="token-usage">
              {[['inputTokens', '输入 Token'], ['outputTokens', '输出 Token']].map(([key, title]) => models.every(model => typeof model.usage?.[key!] === 'number') && (
                <div key={key}>
                  <dt>{title}</dt>
                  <dd>{models.reduce((sum, model) => sum + model.usage![key!]!, 0).toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          )
        : <small>用量未完整报告</small>}
    </div>
  )
}

export function LogModels({ models }: { models: NonNullable<OperationLog['summary']['models']> }) {
  return (
    <details className="technical-details" open>
      <summary>模型与用量</summary>
      <ModelSummary label="LLM" models={models.llm ?? []} />
      <ModelSummary label="Embedding" models={models.embedding ? [models.embedding] : []} />
      <ModelSummary label="Rerank" models={models.rerank ? [models.rerank] : []} />
    </details>
  )
}
