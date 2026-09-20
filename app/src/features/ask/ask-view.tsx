import { ArrowUp, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from '@/features/workspace/store'

export function AskView() {
  const question = useWorkspaceStore(s => s.question)
  const setQuestion = useWorkspaceStore(s => s.setQuestion)
  return (
    <>
      <div className="section-heading">
        <div>
          <div className="eyebrow">ANSWERS WITH CONTEXT</div>
          <h1>
            知识问答
            <span className="title-dot">.</span>
          </h1>
          <p>结合文档与 Wiki 节点，寻找有来源的答案。</p>
        </div>
      </div>
      <div className="ask-workspace">
        <Sparkles className="size-10 text-primary" strokeWidth={1.3} />
        <h2>你想了解什么？</h2>
        <p>知识入库后，即可从这里发起提问。</p>
        <div className="question-composer">
          <textarea
            aria-label="知识库问题"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="输入你的问题…"
            rows={4}
          />
          <div>
            <span>问答服务尚未接入</span>
            <Button size="icon" disabled aria-label="发送问题">
              <ArrowUp />
            </Button>
          </div>
        </div>
        <div className="query-route">
          检索 Top 30
          {' '}
          <span>→</span>
          {' '}
          关联 Wiki 节点
          {' '}
          <span>→</span>
          {' '}
          重排 Top 3
          {' '}
          <span>→</span>
          {' '}
          生成回答
        </div>
      </div>
    </>
  )
}
