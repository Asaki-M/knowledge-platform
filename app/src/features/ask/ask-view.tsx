import type { QueryResult } from './types'
import type { ModelChoice } from '@/features/workspace/model-fields'
import { ArrowRight, ArrowUp, BookOpen, Check, Copy, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { KnowledgeBaseField } from '@/features/workspace/knowledge-base-field'
import { ModelFields } from '@/features/workspace/model-fields'
import { OperationFeedback } from '@/features/workspace/operation-feedback'
import { selectedModel, useWorkspaceStore } from '@/features/workspace/store'
import { useOperation } from '@/features/workspace/use-operation'
import { AnswerMarkdown } from './answer-markdown'

export function AskView() {
  const { question, setQuestion, knowledgeBaseId, options, optionsPending, optionsError, setSection } = useWorkspaceStore()
  const [llm, setLlm] = useState<ModelChoice | null>(null)
  const [submitted, setSubmitted] = useState({ question: '', knowledgeBaseId: '' })
  const [copyStatus, setCopyStatus] = useState('')
  const operation = useOperation<QueryResult>()
  const { result, pending } = operation

  const model = selectedModel(llm, options?.models.llm ?? [])
  const ready = !!model && !optionsPending && !optionsError && !!options?.knowledgeBases.some(kb => kb.id === knowledgeBaseId)

  function submit() {
    if (!question.trim() || !knowledgeBaseId.trim() || pending || !ready || !model)
      return
    setSubmitted({ question: question.trim(), knowledgeBaseId: knowledgeBaseId.trim() })
    setCopyStatus('')
    void operation.run('/api/search', { knowledgeBaseId: knowledgeBaseId.trim(), question: question.trim(), llm: model })
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <div className="eyebrow">ASK YOUR KNOWLEDGE</div>
          <h1>
            知识问答
            <span className="title-dot">.</span>
          </h1>
          <p>从文档与 Wiki 中检索，让每个回答都有来源。</p>
        </div>
        <span className="quiet-label">
          <BookOpen size={14} />
          {' '}
          双路检索 · 引用回答
        </span>
      </div>
      <div className="ask-layout">
        <div className="ask-main">
          <form onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          >
            <fieldset disabled={pending} className="form-fields">
              <KnowledgeBaseField />
              {options && !options.knowledgeBases.some(kb => kb.id === knowledgeBaseId) && <p className="field-hint">请先前往 RAG 过程页新建或选择知识库，并导入文档。</p>}
              <details className="model-options">
                <summary>
                  模型设置
                  <span>{model?.model ?? '未配置'}</span>
                </summary>
                <ModelFields value={llm} onChange={setLlm} />
                <p className="field-hint">问题向量自动沿用知识库的模型与维度。</p>
              </details>
              {!result && !pending && (
                <div className="ask-intro">
                  <span className="ask-symbol"><Sparkles size={28} strokeWidth={1.3} /></span>
                  <h2>从一个问题开始</h2>
                  <p>输入你想了解的内容，查找知识库中的相关依据。</p>
                </div>
              )}
              <div className="question-composer">
                <textarea
                  aria-label="知识库问题"
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  placeholder="向知识库提问…"
                  maxLength={4000}
                  required
                  rows={4}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      e.currentTarget.form?.requestSubmit()
                    }
                  }}
                />
                <div>
                  <span>
                    {question.length}
                    {' '}
                    / 4000
                    {' '}
                    <span className="keyboard-hint">· ⌘ / Ctrl + Enter 发送</span>
                  </span>
                  <Button type="submit" size="icon" disabled={pending || !question.trim() || !ready} aria-label="发送问题"><ArrowUp /></Button>
                </div>
              </div>
            </fieldset>
          </form>
          <OperationFeedback pending={pending} error={operation.error} />
          {result && (
            <section className="answer-section" aria-label="问答结果" aria-live="polite">
              <div className="answer-question">
                <span>
                  本次提问 ·
                  {submitted.knowledgeBaseId}
                </span>
                <h2>{submitted.question}</h2>
              </div>
              {result.status === 'no_results'
                ? (
                    <div className="inline-empty">
                      <BookOpen size={26} />
                      <h3>当前知识库没有可检索的资料</h3>
                      <p>先在 RAG 过程页为这个知识库导入文档。</p>
                      <Button variant="outline" size="sm" onClick={() => setSection('pipeline')}>
                        前往入库
                        <ArrowRight />
                      </Button>
                    </div>
                  )
                : (
                    <>
                      <div className="answer-heading">
                        <span>
                          <Sparkles size={16} />
                          {' '}
                          知序回答
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(result.answer)
                              setCopyStatus('已复制')
                            }
                            catch {
                              setCopyStatus('复制失败，请手动选择文本')
                            }
                          }}
                        >
                          {copyStatus === '已复制' ? <Check /> : <Copy />}
                          复制回答
                        </Button>
                      </div>
                      <AnswerMarkdown text={result.answer} labels={result.sources.map(source => source.label)} />
                      <div className="result-footnote">
                        <span>{result.generation?.model}</span>
                        <span role="status">{copyStatus}</span>
                      </div>
                    </>
                  )}
              <details className="technical-details">
                <summary>请求信息</summary>
                <dl className="detail-list">
                  <div>
                    <dt>请求 ID</dt>
                    <dd>{operation.requestId ?? '未提供'}</dd>
                  </div>
                  <div>
                    <dt>快照版本</dt>
                    <dd>{result.snapshotRevision ?? '无快照'}</dd>
                  </div>
                </dl>
              </details>
            </section>
          )}
        </div>
        <aside className="evidence-panel" aria-label="检索与来源">
          <div className="panel-heading">
            <h2>{result ? '本次检索' : '检索方式'}</h2>
            <span>{result ? `${result.sources.length} 条证据` : 'RAG'}</span>
          </div>
          <div className="retrieval-route">
            <div>
              <span className="route-dot" />
              <span>Chunk 原文</span>
              <strong>{result?.counts.chunks ?? 'Top 30'}</strong>
            </div>
            <div>
              <span className="route-dot" />
              <span>Wiki 知识</span>
              <strong>{result?.counts.wikiNodes ?? 'Top 30'}</strong>
            </div>
            <div className="route-merge">
              <span>合并去重</span>
              <strong>{result?.counts.merged ?? '按内容去重'}</strong>
            </div>
            <div>
              <span className="route-dot filled" />
              <span>重排入选</span>
              <strong>{result?.counts.selected ?? 'Top 5'}</strong>
            </div>
          </div>
          {result?.sources.length
            ? (
                <div className="source-list">
                  {result.sources.map(source => (
                    <details key={source.label} id={`source-${source.label}`} className="source-item" tabIndex={-1}>
                      <summary>
                        <span className="source-label">{source.label}</span>
                        <span>
                          {source.title || '未命名来源'}
                          <small>
                            {[...new Set(source.matches.map(match => match.kind === 'chunk' ? '原文片段' : 'Wiki 节点'))].join(' · ')}
                            {' '}
                            · 重排
                            {' '}
                            {source.rerankScore.toFixed(3)}
                          </small>
                        </span>
                      </summary>
                      <p className="source-text">{source.text}</p>
                      {source.matches.map(match => (
                        <div className="source-meta" key={match.indexId}>
                          <span>
                            向量相似度
                            {match.vectorScore.toFixed(3)}
                          </span>
                          {match.sources.map(item => (
                            <p key={`${item.documentId}-${item.sectionId}`}>
                              {item.sourcePath ?? item.documentId}
                              <br />
                              <span>{item.sectionId}</span>
                            </p>
                          ))}
                        </div>
                      ))}
                    </details>
                  ))}
                </div>
              )
            : (
                <div className="evidence-empty">
                  <BookOpen size={24} strokeWidth={1.3} />
                  <p>
                    回答引用的证据
                    <br />
                    会显示在这里
                  </p>
                </div>
              )}
          <p className="field-hint">来源编号对应检索证据，模型提取的 Wiki 知识仍需结合原文判断。</p>
        </aside>
      </div>
    </>
  )
}
