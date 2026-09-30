import { RefreshCw } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useWorkspaceStore } from './store'

export function KnowledgeBaseField({ allowCreate = false }: { allowCreate?: boolean }) {
  const { knowledgeBaseId, setKnowledgeBaseId, options, optionsPending, drafts, createKnowledgeBase, refreshOptions } = useWorkspaceStore()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const errorId = useId()
  return (
    <div className="knowledge-picker">
      <label className="field">
        <span>知识库</span>
        <select value={knowledgeBaseId} onChange={e => setKnowledgeBaseId(e.target.value)} disabled={optionsPending || !options} required>
          {!knowledgeBaseId && <option value="">{optionsPending ? '正在加载…' : '暂无知识库'}</option>}
          {options?.knowledgeBases.map(kb => <option key={kb.id} value={kb.id}>{kb.id}</option>)}
          {drafts.map(id => <option key={id} value={id}>{`${id} · 待入库`}</option>)}
        </select>
      </label>
      <Button type="button" variant="ghost" size="icon" aria-label="刷新知识库选项" disabled={optionsPending} onClick={() => void refreshOptions()}><RefreshCw size={16} /></Button>
      {allowCreate && (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            setName('')
            setError(null)
          }}
        >
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" disabled={optionsPending || !options}>新建知识库</Button>
          </PopoverTrigger>
          <PopoverContent aria-labelledby={titleId}>
            <h3 id={titleId}>新建知识库</h3>
            <form onSubmit={(e) => {
              // Portal 内的提交事件仍会向 React 父级冒泡，不能触发外层文档入库。
              e.preventDefault()
              e.stopPropagation()
              if (optionsPending || !options)
                return
              const issue = createKnowledgeBase(name)
              setError(issue)
              if (!issue)
                setOpen(false)
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
                  aria-invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.nativeEvent.isComposing)
                      e.preventDefault()
                  }}
                />
              </label>
              {error && <p className="error-text" id={errorId} role="alert">{error}</p>}
              <p className="field-hint">首次入库后保存；未入库的草稿刷新后清空。</p>
              <div className="popover-actions">
                <PopoverClose asChild><Button type="button" variant="ghost" size="sm">取消</Button></PopoverClose>
                <Button type="submit" size="sm" disabled={!name.trim() || optionsPending || !options}>创建</Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
