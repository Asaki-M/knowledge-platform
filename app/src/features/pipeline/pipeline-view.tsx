import type { ModelChoice } from '@/features/workspace/model-fields'
import { ArrowRight, CheckCircle2, FileText, RotateCcw, Square, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { KnowledgeBaseField } from '@/features/workspace/knowledge-base-field'
import { ModelFields } from '@/features/workspace/model-fields'
import { OperationFeedback } from '@/features/workspace/operation-feedback'
import { selectedModel, useWorkspaceStore } from '@/features/workspace/store'
import { ingestionSteps } from './ingestion-steps'
import { PipelineStages } from './pipeline-stages'
import { useIngestion } from './use-ingestion'

export function PipelineView() {
  const { knowledgeBaseId, options, optionsPending, optionsError, refreshOptions, setKnowledgeBaseId, setSection } = useWorkspaceStore()
  const [newDocumentId, setNewDocumentId] = useState(() => `doc-${crypto.randomUUID()}`)
  const [target, setTarget] = useState({ knowledgeBaseId: '', documentId: '' })
  const [sourcePath, setSourcePath] = useState('')
  const [content, setContent] = useState('')
  const [llm, setLlm] = useState<ModelChoice | null>(null)
  const [embedding, setEmbedding] = useState<ModelChoice | null>(null)
  const [fileError, setFileError] = useState('')
  const [reading, setReading] = useState(false)
  const operation = useIngestion()
  const stagesRef = useRef<HTMLDivElement>(null)
  const { result, pending } = operation

  const knowledgeBase = options?.knowledgeBases.find(kb => kb.id === knowledgeBaseId)
  const targetId = target.knowledgeBaseId === knowledgeBaseId && knowledgeBase?.documents.some(doc => doc.id === target.documentId) ? target.documentId : ''
  const documentId = targetId || newDocumentId
  const model = selectedModel(llm, options?.models.llm ?? [])
  const vectorModel = knowledgeBase?.embedding ?? selectedModel(embedding, options?.models.embedding ?? [])
  const ready = !!model && !!vectorModel && !!knowledgeBaseId && !optionsPending && !optionsError

  async function submit() {
    if (pending || reading || !content.trim() || !ready || !model || !vectorModel)
      return
    setFileError('')
    stagesRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
    const stored = await operation.run({
      knowledgeBaseId,
      document: { id: documentId, format: 'nextra-mdx', content, ...(sourcePath && { sourcePath }) },
      llm: model,
      embedding: { provider: vectorModel.provider, model: vectorModel.model },
    })
    if (stored)
      await completed()
  }

  async function completed() {
    setContent('')
    setSourcePath('')
    setTarget({ knowledgeBaseId: '', documentId: '' })
    setNewDocumentId(`doc-${crypto.randomUUID()}`)
    await refreshOptions()
  }

  async function retry() {
    stagesRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    const stored = await operation.retry()
    if (stored)
      await completed()
  }

  async function readFile(file: File | undefined) {
    if (!file)
      return
    setFileError('')
    if (!/\.(?:md|mdx|markdown)$/i.test(file.name) || file.size > 800000) {
      setFileError('请选择 Markdown / MDX 文本文件，大小不超过 800 KB。')
      return
    }
    setReading(true)
    try {
      const text = await file.text()
      if (text.length > 200000)
        throw new Error('正文不能超过 200000 字符。')
      setContent(text)
      setSourcePath(file.name.slice(0, 2048))
      setNewDocumentId(`doc-${crypto.randomUUID()}`)
    }
    catch (error) {
      setFileError(error instanceof Error ? error.message : '文件读取失败，请重新选择。')
    }
    finally { setReading(false) }
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <div className="eyebrow">FROM DOCUMENT TO KNOWLEDGE</div>
          <h1>
            RAG 过程
            <span className="title-dot">.</span>
          </h1>
          <p>导入文档，构建原文与 Wiki 双索引。</p>
        </div>
        <span className="quiet-label">入库工作台</span>
      </div>
      <details className="pipeline-overview">
        <summary>查看入库流程：标准化 → 分节 → 知识提取 → 双索引入库</summary>
        <div className="pipeline-map" aria-label="入库处理链路">
          <div className="flow-node">
            <span>01 / 解析</span>
            <strong>文档标准化</strong>
            <small>Markdown · MDX</small>
          </div>
          <ArrowRight className="flow-arrow" size={18} />
          <div className="flow-node">
            <span>02 / 组织</span>
            <strong>按标题分节</strong>
            <small>Section · 事实来源</small>
          </div>
          <ArrowRight className="flow-arrow" size={18} />
          <div className="flow-branches">
            <div>
              <strong>Chunk 构建</strong>
              <small>原文片段</small>
            </div>
            <div>
              <strong>知识提取 → Wiki</strong>
              <small>实体与概念</small>
            </div>
          </div>
          <ArrowRight className="flow-arrow" size={18} />
          <div className="flow-node flow-destination">
            <span>03 / 索引</span>
            <strong>向量化与入库</strong>
            <small>PostgreSQL / pgvector</small>
          </div>
        </div>
      </details>
      <div ref={stagesRef} className="ingestion-task">
        {result && (
          <div className="ingestion-controls" role="status">
            <div>
              <h2>文档已入库</h2>
              <p className="field-hint">
                {result.normalization.title || result.documentId}
                {' '}
                ·
                {' '}
                {result.counts.sections}
                {' '}
                个章节 ·
                {' '}
                {result.counts.wikiNodes}
                {' '}
                个 Wiki 节点
              </p>
            </div>
            <Button onClick={() => {
              setKnowledgeBaseId(result.knowledgeBaseId)
              setSection('ask')
            }}
            >
              去知识库提问
              <ArrowRight />
            </Button>
          </div>
        )}
        {operation.ingestionId && !result && (
          <div className="ingestion-controls">
            <div>
              <h2>{operation.recovering ? '恢复入库任务' : pending ? '入库进行中' : '入库尚未完成'}</h2>
              <p className="field-hint">{operation.recovering ? '正在恢复最近一次入库任务…' : pending ? '已完成结果会逐节保存，中断后可以继续。' : '继续任务会沿用原文档与模型配置，复用已保存结果。导入其他文档请展开下方表单，新任务会重新处理全文。'}</p>
            </div>
            {pending && !operation.recovering
              ? (
                  <Button type="button" variant="outline" disabled={operation.interrupting} onClick={() => void operation.interrupt()}>
                    <Square />
                    {operation.interrupting ? '正在中断' : '中断处理'}
                  </Button>
                )
              : !operation.recovering && (
                  <Button type="button" disabled={reading || operation.interrupting} onClick={() => void retry()}>
                    <RotateCcw />
                    继续重试
                  </Button>
                )}
          </div>
        )}
        <OperationFeedback pending={false} error={operation.error} />
        {operation.ingestionId && <PipelineStages key={operation.requestId ?? 'draft'} stages={operation.stages} pending={pending} failed={!!operation.error} unconfirmed={operation.error?.code === 'STREAM_INTERRUPTED' || operation.error?.code === 'INVALID_STREAM'} interrupted={operation.error?.code === 'INGESTION_ABORTED'} failureMessage={operation.error?.message} />}
      </div>
      <details className="ingestion-document-form" open={!operation.ingestionId || !!result}>
        <summary>{operation.ingestionId && !result ? '导入新的文档' : '文档与入库设置'}</summary>
        {operation.ingestionId && !result && <p className="field-hint">这里会创建新任务并重新处理全文。继续原任务请使用上方“继续重试”。</p>}
        <div className="pipeline-workspace">
          <section className="ingest-editor">
            <div className="panel-heading">
              <h2>导入文档</h2>
              <span>纯文本接入</span>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
            >
              <fieldset disabled={pending || reading} className="form-fields">
                <KnowledgeBaseField allowCreate />
                <label className="field">
                  <span>文档操作</span>
                  <select
                    value={targetId}
                    onChange={(e) => {
                      setTarget({ knowledgeBaseId, documentId: e.target.value })
                      if (!e.target.value)
                        setNewDocumentId(`doc-${crypto.randomUUID()}`)
                    }}
                  >
                    <option value="">新增文档（自动生成标识）</option>
                    {knowledgeBase?.documents.map(doc => <option key={doc.id} value={doc.id}>{`更新：${doc.label}`}</option>)}
                  </select>
                </label>
                <p className="field-hint">{targetId ? '将完整更新所选文档，请确认上传内容对应这份文档。' : '新文档自动分配独立标识，同名文件也不会覆盖已有文档。'}</p>
                <div className="editor-label">
                  <label htmlFor="document-content">文档正文</label>
                  <label className="file-picker">
                    <Upload size={14} />
                    {' '}
                    选择文件
                    <input
                      type="file"
                      aria-label="选择 Markdown 或 MDX 文件"
                      accept=".md,.mdx,.markdown,text/markdown"
                      onChange={(e) => {
                        void readFile(e.target.files?.[0])
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
                <textarea id="document-content" className="document-editor" value={content} onChange={e => setContent(e.target.value)} placeholder={'# 文档标题\n\n在这里粘贴 Markdown 或 MDX 内容…'} maxLength={200000} required rows={8} spellCheck={false} />
                <div className="editor-footer">
                  <span>Markdown / MDX</span>
                  <span>
                    {content.length.toLocaleString()}
                    {' '}
                    / 200,000 字符
                  </span>
                </div>
                <details className="model-options">
                  <summary>
                    入库设置
                    <span>模型与来源</span>
                  </summary>
                  <p className="field-hint">
                    来源：
                    {sourcePath || '粘贴的文档'}
                    （自动识别）
                  </p>
                  <ModelFields value={llm} onChange={setLlm} />
                  {knowledgeBase
                    ? (
                        <p className="field-hint">
                          向量模型沿用知识库：
                          {knowledgeBase.embedding.model}
                          {' '}
                          ·
                          {knowledgeBase.embedding.dimensions ?? '默认'}
                          {' '}
                          维
                        </p>
                      )
                    : <ModelFields embedding value={embedding} onChange={setEmbedding} />}
                  <p className="field-hint">模型来自服务端配置，向量维度自动确定。</p>
                </details>
                <div className="form-actions">
                  <span>{!ready ? '请先选择知识库并配置模型' : !content.trim() ? '选择文件或粘贴正文后开始' : '完成全部处理后写入知识库'}</span>
                  <Button type="submit" disabled={pending || reading || !content.trim() || !ready}>
                    <Upload />
                    {pending ? '正在入库' : operation.ingestionId && !result ? '作为新任务入库' : '开始入库'}
                  </Button>
                </div>
              </fieldset>
            </form>
            {reading && <p role="status" className="field-hint">正在读取文件…</p>}
            {fileError && <div role="alert" className="notice error-notice">{fileError}</div>}

          </section>
          <aside className="ingest-result">
            <div className="panel-heading">
              <h2>处理结果</h2>
              <span>{pending ? '等待返回' : result ? '已入库' : operation.ingestionId ? '未完成' : '等待导入'}</span>
            </div>
            {result
              ? (
                  <div aria-live="polite">
                    <div className="success-heading">
                      <CheckCircle2 size={20} />
                      <div>
                        <strong>{result.normalization.title || result.documentId}</strong>
                        <small>
                          {result.knowledgeBaseId}
                          {' '}
                          /
                          {' '}
                          {result.documentId}
                        </small>
                      </div>
                    </div>
                    <dl className="result-counts">
                      {[['章节', result.counts.sections], ['原文片段', result.counts.chunks], ['Wiki 节点', result.counts.wikiNodes], ['语义关系', result.counts.wikiEdges], ['本次向量', result.counts.vectors], ['标准化字符', result.normalization.characters]].map(([label, count]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{count}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="field-hint">
                      当前全库：
                      {result.stored.chunks}
                      {' '}
                      个 Chunk，
                      {result.stored.wikiNodes}
                      {' '}
                      个 Wiki 节点。
                    </p>
                    <dl className="detail-list">
                      <div>
                        <dt>向量模型</dt>
                        <dd>{result.embedding.model ?? '未提供'}</dd>
                      </div>
                      <div>
                        <dt>向量维度</dt>
                        <dd>{result.embedding.dimensions ?? '未提供'}</dd>
                      </div>
                    </dl>
                    {result.normalization.warnings.length > 0 && (
                      <details className="technical-details">
                        <summary>
                          标准化警告（
                          {result.normalization.warnings.length}
                          ）
                        </summary>
                        <ul className="warning-list">{[...new Set(result.normalization.warnings.map(warning => warning.message))].map(message => <li key={message}>{message}</li>)}</ul>
                      </details>
                    )}
                    <details className="technical-details">
                      <summary>请求与版本</summary>
                      <dl className="detail-list">
                        <div>
                          <dt>请求 ID</dt>
                          <dd>{operation.requestId ?? '未提供'}</dd>
                        </div>
                        <div>
                          <dt>快照版本</dt>
                          <dd>{result.stored.revision}</dd>
                        </div>
                      </dl>
                    </details>
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={() => {
                        setKnowledgeBaseId(result.knowledgeBaseId)
                        setSection('ask')
                      }}
                    >
                      使用此知识库提问
                      <ArrowRight />
                    </Button>
                  </div>
                )
              : (
                  <div className="inline-empty">
                    <FileText size={30} strokeWidth={1.3} />
                    <h3>{pending ? '文档正在处理' : operation.ingestionId ? '任务未完成' : '等待第一份文档'}</h3>
                    <p>{pending ? '上方实时显示当前阶段，全部完成后在这里查看入库结果。' : operation.ingestionId ? '已保存的处理结果可以复用。点击继续重试，从未完成的位置继续。' : '提交文档后，在这里查看构建数量、模型信息与入库结果。'}</p>
                  </div>
                )}
            <div className="capability-note">文件在浏览器读取为文本，原始文件暂不存档。可在任务进度中查看各阶段产物。</div>
          </aside>
        </div>

      </details>
      <details className="pipeline-reference">
        <summary>了解各阶段的输入与输出</summary>
        <div>
          {ingestionSteps.map((step, index) => (
            <div className="pipeline-row" key={step.code}>
              <span className="step-number">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <h3>{step.name}</h3>
                <p>{step.description}</p>
              </div>
              <span className="step-code">{step.code}</span>
            </div>
          ))}
        </div>
      </details>
    </>
  )
}
