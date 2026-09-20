import type { Section } from './store'
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  FileText,
  GitBranch,
  Layers,
  Network,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AskView } from '@/features/ask/ask-view'
import { DocumentsView } from '@/features/documents/documents-view'
import { ingestionSteps } from '@/features/pipeline/ingestion-steps'
import { PipelineView } from '@/features/pipeline/pipeline-view'
import { WikiView } from '@/features/wiki/wiki-view'
import { cn } from '@/utils/cn'
import { useWorkspaceStore } from './store'
import { useHealth } from './use-health'

const navigation = [
  { id: 'documents', label: '文档库', icon: FileText },
  { id: 'wiki', label: 'Wiki 节点', icon: Network },
  { id: 'ask', label: '知识问答', icon: Sparkles },
  { id: 'pipeline', label: '处理流程', icon: GitBranch },
] satisfies { id: Section, label: string, icon: typeof FileText }[]

export function WorkspacePage() {
  const section = useWorkspaceStore(s => s.section)
  const setSection = useWorkspaceStore(s => s.setSection)
  const { status, refresh } = useHealth()
  const views = {
    documents: <DocumentsView />,
    wiki: <WikiView />,
    ask: <AskView />,
    pipeline: <PipelineView />,
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="知序首页">
          <span className="brand-symbol">
            <BookOpen size={21} strokeWidth={1.7} />
          </span>
          <span>
            知序
            <span className="brand-en"> / WIKI</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">K</span>
          <div>
            个人知识空间
            <small>Personal workspace</small>
          </div>
        </div>
        <div className="nav-caption">工作空间</div>
        <nav aria-label="工作空间导航">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={cn('nav-item', section === id && 'selected')}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => setSection(id)}
            >
              <Icon size={18} strokeWidth={1.65} />
              <span>{label}</span>
              {id === 'documents' && <span className="nav-count">0</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="edition-mark">
            <Layers size={17} />
            <span>
              Wiki RAG
              <small>知识的每一层，都有连接。</small>
            </span>
          </div>
          <div className="profile">
            <span className="profile-avatar">我</span>
            <span>我的工作空间</span>
            <span className="local-tag">本地</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>
              {navigation.find(item => item.id === section)?.label}
            </strong>
          </div>
          <div className="service-status" role="status">
            <span
              className={cn('status-dot', status === 'online' && 'online')}
            />
            {status === 'online'
              ? '服务已连接'
              : status === 'checking'
                ? '正在连接'
                : '服务未连接'}
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新服务状态"
              onClick={() => void refresh()}
              disabled={status === 'checking'}
            >
              <RefreshCw
                className={cn(status === 'checking' && 'animate-spin')}
              />
            </Button>
          </div>
        </header>
        <div className="content-layout">
          <main id="main-content" className="main-content" tabIndex={-1}>
            <div className="view-enter" key={section}>
              {views[section]}
            </div>
          </main>
          <aside className="context-panel" aria-label="知识库概览">
            <div className="context-label">
              知识库概览
              {' '}
              <span>01</span>
            </div>
            <h2>从文档到知识</h2>
            <p>让内容形成结构，让回答拥有依据。</p>
            <div className="mini-pipeline">
              {ingestionSteps.map((step, index) => (
                <div className="mini-step" key={step.code}>
                  <span className="mini-step-marker">{index + 1}</span>
                  <div>
                    <strong>{step.name}</strong>
                    <small>{step.code}</small>
                  </div>
                </div>
              ))}
            </div>
            <Button
              variant="ghost"
              className="pipeline-link"
              onClick={() => setSection('pipeline')}
            >
              查看完整流程
              <ArrowUpRight />
            </Button>
            <div className="context-divider" />
            <div className="context-label">检索策略</div>
            <dl className="retrieval-details">
              <div>
                <dt>候选召回</dt>
                <dd>Top 30</dd>
              </div>
              <div>
                <dt>关联上下文</dt>
                <dd>Wiki Node</dd>
              </div>
              <div>
                <dt>精排结果</dt>
                <dd>Top 3</dd>
              </div>
            </dl>
            <div className="context-footnote">
              <span className="small-square" />
              等待首份文档入库
            </div>
          </aside>
        </div>
        <footer className="app-footer">
          <span>知序 · KNOWLEDGE PLATFORM</span>
          <span>让知识有迹可循</span>
        </footer>
      </div>
    </div>
  )
}
