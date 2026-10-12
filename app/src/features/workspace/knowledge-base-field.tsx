import type { KnowledgeBaseOption } from './store'
import { Pencil, RefreshCw } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useWorkspaceStore } from './store'

export function KnowledgeBaseField({ allowCreate = false }: { allowCreate?: boolean }) {
  const { knowledgeBaseId, setKnowledgeBaseId, options, optionsPending, knowledgeBaseSaving, refreshOptions } = useWorkspaceStore()
  const selected = options?.knowledgeBases.find(kb => kb.id === knowledgeBaseId)
  return (
    <>
      <div className="knowledge-picker">
        <label className="field">
          <span>知识库</span>
          <select value={knowledgeBaseId} onChange={e => setKnowledgeBaseId(e.target.value)} disabled={optionsPending || knowledgeBaseSaving || !options} required>
            {!knowledgeBaseId && <option value="">{optionsPending ? '正在加载…' : '暂无知识库'}</option>}
            {options?.knowledgeBases.map(kb => <option key={kb.id} value={kb.id}>{kb.documents.length ? kb.id : `${kb.id} · 待入库`}</option>)}
          </select>
        </label>
        <Button type="button" variant="ghost" size="icon" aria-label="刷新知识库选项" disabled={optionsPending || knowledgeBaseSaving} onClick={() => void refreshOptions()}><RefreshCw size={16} /></Button>
        {selected && <KnowledgeBaseEditor key={selected.id} knowledgeBase={selected} />}
        {allowCreate && <KnowledgeBaseEditor />}
      </div>
      {selected?.description && <p className="field-hint knowledge-description">{selected.description}</p>}
    </>
  )
}

function KnowledgeBaseEditor({ knowledgeBase }: { knowledgeBase?: KnowledgeBaseOption }) {
  const { options, optionsPending, knowledgeBaseSaving, createKnowledgeBase, updateKnowledgeBaseDescription } = useWorkspaceStore()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const errorId = useId()
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (knowledgeBaseSaving)
          return
        setOpen(next)
        setName(knowledgeBase?.id ?? '')
        setDescription(knowledgeBase?.description ?? '')
        setError(null)
      }}
    >
      <PopoverTrigger asChild>
        {knowledgeBase
          ? <Button type="button" variant="ghost" size="icon" aria-label="编辑知识库描述" disabled={optionsPending || knowledgeBaseSaving || !options}><Pencil size={16} /></Button>
          : <Button type="button" variant="outline" disabled={optionsPending || knowledgeBaseSaving || !options}>新建知识库</Button>}
      </PopoverTrigger>
      <PopoverContent className="knowledge-base-editor" aria-labelledby={titleId}>
        <h3 id={titleId}>{knowledgeBase ? '编辑知识库描述' : '新建知识库'}</h3>
        <form onSubmit={(e) => {
          // Portal 内的提交事件仍会向 React 父级冒泡，不能触发外层文档入库。
          e.preventDefault()
          e.stopPropagation()
          if (optionsPending || knowledgeBaseSaving || !options)
            return
          void (knowledgeBase ? updateKnowledgeBaseDescription(knowledgeBase.id, description) : createKnowledgeBase(name, description)).then((issue) => {
            setError(issue?.message ?? null)
            if (!issue)
              setOpen(false)
          })
        }}
        >
          <label className="field">
            <span>知识库名称</span>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              placeholder="例如：产品文档"
              maxLength={64}
              required
              readOnly={!!knowledgeBase}
              disabled={knowledgeBaseSaving}
              aria-invalid={!!error}
              aria-describedby={error ? errorId : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.nativeEvent.isComposing)
                  e.preventDefault()
              }}
            />
          </label>
          <label className="field">
            <span>
              内容描述
              <span className="optional">（可选）</span>
            </span>
            <textarea
              className="knowledge-description-editor"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="例如：React、TypeScript 和组件设计笔记，适合查询前端实践与问题排查。"
              maxLength={1000}
              rows={4}
              disabled={knowledgeBaseSaving}
            />
          </label>
          {error && <p className="error-text" id={errorId} role="alert">{error}</p>}
          <p className="field-hint">描述用于帮助 GPT 选择知识库。保存到数据库后，刷新或换电脑仍可读取。</p>
          <div className="popover-actions">
            <PopoverClose asChild><Button type="button" variant="ghost" size="sm" disabled={knowledgeBaseSaving}>取消</Button></PopoverClose>
            <Button type="submit" size="sm" disabled={!name.trim() || optionsPending || knowledgeBaseSaving || !options}>{knowledgeBaseSaving ? '正在保存…' : knowledgeBase ? '保存' : '创建'}</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
