import { ArrowUpRight, FileText, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspaceStore } from '@/features/workspace/store'

export function DocumentsView() {
  const query = useWorkspaceStore(s => s.documentQuery)
  const setQuery = useWorkspaceStore(s => s.setDocumentQuery)
  const setSection = useWorkspaceStore(s => s.setSection)

  return (
    <>
      <div className="section-heading">
        <div>
          <div className="eyebrow">YOUR KNOWLEDGE, CONNECTED</div>
          <h1>
            我的知识库
            <span className="title-dot">.</span>
          </h1>
          <p>从一份文档开始，让知识彼此连接。</p>
        </div>
        <Button disabled title="文档导入功能尚未接入">
          <Plus />
          导入文档
        </Button>
      </div>
      <div className="summary-strip">
        {[
          ['文档', '00'],
          ['Wiki 节点', '00'],
          ['索引片段', '00'],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <span className="summary-unit">
              {label === '文档' ? '篇' : '个'}
            </span>
          </div>
        ))}
      </div>
      <div className="list-toolbar">
        <div className="active-tab">
          全部文档
          {' '}
          <span>0</span>
        </div>
        <div className="relative w-full max-w-64">
          <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索文档"
            placeholder="搜索文档名称…"
            className="pl-9"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="table-heading" aria-hidden="true">
        <span>文档名称</span>
        <span>处理状态</span>
        <span>最近更新</span>
      </div>
      <div className="empty-state">
        <div className="document-illustration" aria-hidden="true">
          <div className="paper-back" />
          <div className="paper-front">
            <FileText strokeWidth={1.2} />
            <span />
            <span />
            <span />
          </div>
          <div className="paper-mark">+</div>
        </div>
        <h2>
          {query.trim() ? '没有找到匹配的文档' : '你的第一份知识，等待入库'}
        </h2>
        <p>
          {query.trim()
            ? '知识库目前为空，导入文档后即可在这里搜索。'
            : '在这里管理 Markdown 与 MDX 文档，构建属于你的 Wiki。'}
        </p>
        <span className="pending-note">文档导入即将接入</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSection('pipeline')}
        >
          了解知识处理流程
          {' '}
          <ArrowUpRight />
        </Button>
      </div>
      <div className="bottom-note">
        <span className="small-square" />
        原始文档 → 结构化知识 → 有据可循的回答
      </div>
    </>
  )
}
