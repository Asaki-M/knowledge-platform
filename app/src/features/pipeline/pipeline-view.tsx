import type { IngestionResult } from './types'
import type { ModelChoice } from '@/features/workspace/model-fields'
import { ArrowRight, CheckCircle2, FileText, Upload } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { KnowledgeBaseField } from '@/features/workspace/knowledge-base-field'
import { ModelFields } from '@/features/workspace/model-fields'
import { OperationFeedback } from '@/features/workspace/operation-feedback'
import { selectedModel, useWorkspaceStore } from '@/features/workspace/store'
import { useOperation } from '@/features/workspace/use-operation'
import { ingestionSteps } from './ingestion-steps'

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
  const operation = useOperation<IngestionResult>()
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
    const stored = await operation.run('/api/documents/ingest', {
      knowledgeBaseId,
      document: { id: documentId, format: 'nextra-mdx', content, ...(sourcePath && { sourcePath }) },
      llm: model,
      embedding: { provider: vectorModel.provider, model: vectorModel.model },
    })
    if (stored) {
      // 成功后准备下一份新文档；失败时保留正文和身份，方便修正后重新提交。
      setContent('')
      setSourcePath('')
      setTarget({ knowledgeBaseId: '', documentId: '' })
      setNewDocumentId(`doc-${crypto.randomUUID()}`)
      await refreshOptions()
    }
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
              <textarea id="document-content" className="document-editor" value={content} onChange={e => setContent(e.target.value)} placeholder={'# 文档标题\n\n在这里粘贴 Markdown 或 MDX 内容…'} maxLength={200000} required rows={12} spellCheck={false} />
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
                <span>完整处理后一次性写入</span>
                <Button type="submit" disabled={pending || reading || !content.trim() || !ready}>
                  <Upload />
                  {pending ? '正在入库' : '开始入库'}
                </Button>
              </div>
            </fieldset>
          </form>
          {reading && <p role="status" className="field-hint">正在读取文件…</p>}
          {fileError && <div role="alert" className="notice error-notice">{fileError}</div>}
          <OperationFeedback pending={pending} error={operation.error} />
        </section>
        <aside className="ingest-result">
          <div className="panel-heading">
            <h2>处理结果</h2>
            <span>{pending ? '等待返回' : result ? '已入库' : '等待导入'}</span>
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
                    去知识库提问
                    <ArrowRight />
                  </Button>
                </div>
              )
            : (
                <div className="inline-empty">
                  <FileText size={30} strokeWidth={1.3} />
                  <h3>{pending ? '文档正在处理' : '等待第一份文档'}</h3>
                  <p>{pending ? '服务端处理完成后，会在这里显示真实的章节、知识节点和向量数量。' : '提交文档后，在这里查看构建数量、模型信息与入库结果。'}</p>
                </div>
              )}
          <div className="capability-note">当前提供处理完成后的结果摘要；暂不提供实时阶段进度和中间对象预览。文件在浏览器读取为文本，原始文件暂不存档。</div>
        </aside>
      </div>
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
