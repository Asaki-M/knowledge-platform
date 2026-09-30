import type { LogPage, OperationLog } from './types'
import type { ApiError } from '@/utils/api'
import { ChevronLeft, ChevronRight, ListFilter, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { OperationFeedback } from '@/features/workspace/operation-feedback'
import { useWorkspaceStore } from '@/features/workspace/store'
import { errorMessage, requestJson } from '@/utils/api'
import { LogModels } from './log-models'

const statusLabels = { running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' }
const countLabels: Record<string, string> = { sections: '章节', chunks: 'Chunk', wikiNodes: 'Wiki 节点', wikiEdges: '关系', vectors: '向量', merged: '去重后', duplicates: '重复', selected: '入选' }
const initialFilters = { type: '', status: '', knowledgeBaseId: '', documentId: '', requestId: '', period: '' }

function date(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}
function duration(value: number | null) {
  return value === null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`
}

export function LogsView({ active }: { active: boolean }) {
  const { options, refreshOptions } = useWorkspaceStore()
  const [draft, setDraft] = useState(initialFilters)
  const [query, setQuery] = useState('')
  const [cursors, setCursors] = useState<string[]>([])
  const [page, setPage] = useState<LogPage | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [reload, setReload] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OperationLog | null>(null)
  const [detailPending, setDetailPending] = useState(false)
  const [detailError, setDetailError] = useState<ApiError | null>(null)
  const detailRef = useRef<HTMLElement>(null)
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null)
  const cursor = cursors.at(-1)

  useEffect(() => {
    if (active)
      void refreshOptions()
  }, [active, refreshOptions])

  useEffect(() => {
    if (!active)
      return
    const controller = new AbortController()
    async function load() {
      await Promise.resolve()
      if (controller.signal.aborted)
        return
      setPending(true)
      setError(null)
      setPage(null)
      const parameters = new URLSearchParams(query)
      parameters.set('limit', '20')
      if (cursor)
        parameters.set('cursor', cursor)
      try {
        const { data } = await requestJson<LogPage>(`/api/logs?${parameters}`, { signal: controller.signal })
        if (!controller.signal.aborted)
          setPage(data)
      }
      catch (e) {
        if (!controller.signal.aborted)
          setError(errorMessage(e))
      }
      finally {
        if (!controller.signal.aborted)
          setPending(false)
      }
    }
    void load()
    // 切换筛选或页码时取消旧请求，避免较慢的响应覆盖新结果。
    return () => controller.abort()
  }, [active, query, cursor, reload])

  useEffect(() => {
    if (!active || !selectedId)
      return
    const controller = new AbortController()
    async function loadDetail() {
      await Promise.resolve()
      if (controller.signal.aborted || !selectedId)
        return
      setDetail(null)
      setDetailError(null)
      setDetailPending(true)
      detailRef.current?.focus()
      try {
        const { data } = await requestJson<OperationLog>(`/api/logs/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
        if (!controller.signal.aborted)
          setDetail(data)
      }
      catch (e) {
        if (!controller.signal.aborted)
          setDetailError(errorMessage(e))
      }
      finally {
        if (!controller.signal.aborted)
          setDetailPending(false)
      }
    }
    void loadDetail()
    return () => controller.abort()
  }, [active, selectedId, reload])

  function closeDetail() {
    setSelectedId(null)
    selectedButtonRef.current?.focus()
  }

  const scopes = options?.logScopes ?? []
  const knowledgeBases = [...new Set(scopes.map(item => item.knowledgeBaseId))]
  const documents = [...new Set(scopes.filter(item => !draft.knowledgeBaseId || item.knowledgeBaseId === draft.knowledgeBaseId).flatMap(item => item.documentId ? [item.documentId] : []))]

  function applyFilters(filters = draft) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) {
      if (value && key !== 'period')
        params.set(key, value)
    }
    if (filters.period)
      params.set('from', new Date(Date.now() - Number(filters.period) * 3600000).toISOString())
    setCursors([])
    setQuery(params.toString())
    setSelectedId(null)
    setReload(value => value + 1)
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <div className="eyebrow">OPERATIONS & TRACE</div>
          <h1>
            操作日志
            <span className="title-dot">.</span>
          </h1>
          <p>查看每一次入库与问答的状态、用量和请求记录。</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            setReload(value => value + 1)
            void refreshOptions()
          }}
        >
          <RefreshCw className={pending ? 'animate-spin' : ''} />
          刷新
        </Button>
      </div>
      <form
        className="log-filters"
        onSubmit={(e) => {
          e.preventDefault()
          applyFilters()
        }}
      >
        <div className="filter-primary">
          <label className="field">
            <span>操作类型</span>
            <select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value })}>
              <option value="">全部操作</option>
              <option value="ingestion">文档入库</option>
              <option value="query">知识问答</option>
            </select>
          </label>
          <label className="field">
            <span>状态</span>
            <select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}>
              <option value="">全部状态</option>
              {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>知识库</span>
            <select value={draft.knowledgeBaseId} onChange={e => setDraft({ ...draft, knowledgeBaseId: e.target.value, documentId: '' })}>
              <option value="">全部知识库</option>
              {knowledgeBases.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <Button type="submit" size="sm">
            <Search />
            筛选
          </Button>
        </div>
        <details className="advanced-filters">
          <summary>
            <ListFilter size={13} />
            更多筛选
          </summary>
          <div className="form-row">
            <label className="field">
              <span>文档</span>
              <select value={draft.documentId} onChange={e => setDraft({ ...draft, documentId: e.target.value })}>
                <option value="">全部文档</option>
                {documents.map(id => <option key={id} value={id}>{options?.knowledgeBases.flatMap(kb => kb.documents).find(doc => doc.id === id)?.label ?? id}</option>)}
              </select>
            </label>
            <label className="field">
              <span>时间范围</span>
              <select value={draft.period} onChange={e => setDraft({ ...draft, period: e.target.value })}>
                <option value="">全部时间</option>
                <option value="1">最近 1 小时</option>
                <option value="24">最近 24 小时</option>
                <option value="168">最近 7 天</option>
                <option value="720">最近 30 天</option>
              </select>
            </label>
          </div>
        </details>
        {query && (
          <div className="filter-applied">
            <span>已应用筛选条件</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(initialFilters)
                setQuery('')
                setCursors([])
                setSelectedId(null)
              }}
            >
              清除筛选
              <X />
            </Button>
          </div>
        )}
        {draft.requestId && (
          <p className="field-hint">
            当前请求：
            {draft.requestId}
          </p>
        )}
      </form>
      <div className={selectedId ? 'logs-layout has-detail' : 'logs-layout'}>
        <section className="log-list" aria-label="操作记录">
          <div className="panel-heading">
            <h2>操作记录</h2>
            <span>{page ? `本页 ${page.items.length} 条` : '每页 20 条'}</span>
          </div>
          <OperationFeedback read pending={pending} error={error} />
          {error && <Button variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>重新加载</Button>}
          {page && (page.items.length
            ? (
                <div className="log-table-scroll">
                  <table className="log-table">
                    <thead>
                      <tr>
                        <th>操作 / 知识库</th>
                        <th>状态</th>
                        <th>开始时间</th>
                        <th>耗时</th>
                        <th><span className="sr-only">详情</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map(item => (
                        <tr key={item.id} className={selectedId === item.id ? 'selected-row' : ''}>
                          <td>
                            <strong>{item.type === 'ingestion' ? '文档入库' : '知识问答'}</strong>
                            <small>
                              {item.knowledgeBaseId ?? '未知知识库'}
                              {item.documentId && ` / ${item.documentId}`}
                            </small>
                          </td>
                          <td>
                            <span className={`status-badge ${item.status}`}>
                              <i />
                              {statusLabels[item.status]}
                            </span>
                          </td>
                          <td className="time-cell">{date(item.startedAt)}</td>
                          <td className="duration-cell">{duration(item.durationMs)}</td>
                          <td>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`查看日志 ${item.id}`}
                              onClick={(e) => {
                                selectedButtonRef.current = e.currentTarget
                                setSelectedId(item.id)
                              }}
                            >
                              <ChevronRight />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            : (
                <div className="inline-empty log-empty">
                  <ListFilter size={30} strokeWidth={1.3} />
                  <h3>{query ? '没有匹配的操作记录' : '暂无操作记录'}</h3>
                  <p>{query ? '调整筛选条件后重新查询。' : '完成文档入库或知识问答后，操作记录会显示在这里。'}</p>
                </div>
              ))}
          <div className="pagination">
            <span>
              第
              {cursors.length + 1}
              {' '}
              页
            </span>
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={!cursors.length || pending}
                onClick={() => {
                  setCursors(value => value.slice(0, -1))
                  setSelectedId(null)
                }}
              >
                <ChevronLeft />
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!page?.nextCursor || pending}
                onClick={() => {
                  if (page?.nextCursor)
                    setCursors(value => [...value, page.nextCursor!])
                  setSelectedId(null)
                }}
              >
                下一页
                <ChevronRight />
              </Button>
            </div>
          </div>
        </section>
        {selectedId && (
          <aside
            className="log-detail"
            aria-label="日志详情"
            ref={detailRef}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === 'Escape')
                closeDetail()
            }}
          >
            <div className="panel-heading">
              <h2>
                日志 #
                {selectedId}
              </h2>
              <Button variant="ghost" size="icon" aria-label="关闭日志详情" onClick={closeDetail}><X /></Button>
            </div>
            <OperationFeedback read pending={detailPending} error={detailError} />
            {detailError && <Button variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>重试详情</Button>}
            {detail && (
              <>
                <span className={`status-badge ${detail.status}`}>
                  <i />
                  {statusLabels[detail.status]}
                </span>
                {detail.status === 'running' && <p className="field-hint">尚未记录结束状态；任务可能已结束但未成功回写日志。</p>}
                <dl className="detail-list">
                  {[['操作类型', detail.type === 'ingestion' ? '文档入库' : '知识问答'], ['知识库', detail.knowledgeBaseId], ['文档', detail.documentId], ['开始时间', date(detail.startedAt)], ['结束时间', date(detail.finishedAt)], ['耗时', duration(detail.durationMs)], ['HTTP 状态', detail.httpStatus], ['结果', detail.summary.resultStatus], ['请求 ID', detail.requestId], ['Trace ID', detail.traceId]].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value ?? '—'}</dd>
                    </div>
                  ))}
                </dl>
                {detail.requestId && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const filters = { ...initialFilters, requestId: detail.requestId! }
                      setDraft(filters)
                      applyFilters(filters)
                    }}
                  >
                    仅看此请求
                  </Button>
                )}
                {detail.error && (
                  <div className="notice error-notice">
                    <div>
                      {detail.error.message}
                      <small>
                        {detail.error.code}
                        {' '}
                        ·
                        {' '}
                        {detail.error.retryable ? '可重试' : '不可自动重试'}
                      </small>
                    </div>
                  </div>
                )}
                {detail.summary.counts && (
                  <>
                    <h3 className="detail-subheading">阶段数量</h3>
                    <dl className="result-counts">
                      {Object.entries(detail.summary.counts).map(([key, value]) => (
                        <div key={key}>
                          <dt>{countLabels[key] ?? key}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                )}
                {detail.summary.normalization && (
                  <p className="field-hint">
                    标准化
                    {detail.summary.normalization.characters}
                    {' '}
                    字符 ·
                    {detail.summary.normalization.warningCount}
                    {' '}
                    条警告
                  </p>
                )}
                {detail.summary.models && <LogModels models={detail.summary.models} />}
                {detail.summary.snapshotRevision && (
                  <details className="technical-details">
                    <summary>快照版本</summary>
                    <p className="mono-text">{detail.summary.snapshotRevision}</p>
                  </details>
                )}
              </>
            )}
          </aside>
        )}
      </div>
      <div className="bottom-note">
        <span className="small-square" />
        日志保留操作摘要，不保存文档正文、问题和答案；历史操作不会自动补录。
      </div>
    </>
  )
}
