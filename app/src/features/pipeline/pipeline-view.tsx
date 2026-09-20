import { ingestionSteps } from './ingestion-steps'

const querySteps = [
  {
    name: '语义检索与 Wiki 关联',
    code: 'TOP 30 + WIKI',
    description: '召回 30 个候选片段，并补充关联节点。',
  },
  {
    name: '结果重排',
    code: 'RERANK TOP 3',
    description: '按相关性重排，选出 3 个上下文片段。',
  },
  {
    name: '生成答案',
    code: 'ANSWER',
    description: '结合上下文与来源生成回答。',
  },
]

const sections = [
  { label: '知识入库', steps: ingestionSteps },
  { label: '检索与问答', steps: querySteps },
]

export function PipelineView() {
  return (
    <>
      <div className="section-heading">
        <div>
          <div className="eyebrow">FROM DOCUMENTS TO ANSWERS</div>
          <h1>
            处理流程
            <span className="title-dot">.</span>
          </h1>
          <p>知识入库与问答链路，按阶段逐步接入。</p>
        </div>
      </div>
      {sections.map(({ label, steps }) => (
        <section key={label} className="pipeline-section">
          <h2>
            {label}
            <span>尚未接入</span>
          </h2>
          {steps.map((step, index) => (
            <div className="pipeline-row" key={step.code}>
              <span className="step-number">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div>
                <h3>{step.name}</h3>
                <p>{step.description}</p>
              </div>
              <span className="step-code">{step.code}</span>
            </div>
          ))}
        </section>
      ))}
    </>
  )
}
