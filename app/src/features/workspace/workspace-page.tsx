import type { Section } from './store'
import { BookOpen, ChevronRight, GitBranch, Layers, ListFilter, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AskView } from '@/features/ask/ask-view'
import { LogsView } from '@/features/logs/logs-view'
import { PipelineView } from '@/features/pipeline/pipeline-view'
import { cn } from '@/utils/cn'
import { OperationFeedback } from './operation-feedback'
import { useWorkspaceStore } from './store'
import { useHealth } from './use-health'

const navigation = [
  { id: 'ask', label: '知识问答', icon: Sparkles, code: '01' },
  { id: 'pipeline', label: 'RAG 过程', icon: GitBranch, code: '02' },
  { id: 'logs', label: '操作日志', icon: ListFilter, code: '03' },
] satisfies { id: Section, label: string, icon: typeof Sparkles, code: string }[]

export function WorkspacePage() {
  const section = useWorkspaceStore(s => s.section)
  const setSection = useWorkspaceStore(s => s.setSection)
  const { optionsPending, optionsError, refreshOptions } = useWorkspaceStore()
  useEffect(() => {
    void refreshOptions()
  }, [refreshOptions])
  const { status, refresh } = useHealth()
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="知序首页">
          <span className="brand-symbol"><BookOpen size={21} strokeWidth={1.7} /></span>
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
          {navigation.map(({ id, label, icon: Icon, code }) => (
            <button key={id} type="button" className={cn('nav-item', section === id && 'selected')} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
              <Icon size={18} strokeWidth={1.65} />
              <span>{label}</span>
              <span className="nav-count">{code}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="edition-mark">
            <Layers size={17} />
            <span>
              Wiki RAG
              <small>文档 · 知识 · 回答</small>
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
            <strong>{navigation.find(item => item.id === section)?.label}</strong>
          </div>
          <div className="service-status" role="status">
            <span className={cn('status-dot', status === 'online' && 'online')} />
            {status === 'online' ? '服务已连接' : status === 'checking' ? '正在连接' : '服务未连接'}
            <Button variant="ghost" size="icon" aria-label="刷新服务状态" onClick={() => void refresh()} disabled={status === 'checking'}><RefreshCw className={cn(status === 'checking' && 'animate-spin')} /></Button>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {optionsError && (
            <div className="workspace-options-error">
              <OperationFeedback read error={optionsError} pending={false} />
              <Button variant="outline" size="sm" disabled={optionsPending} onClick={() => void refreshOptions()}>重新加载选项</Button>
            </div>
          )}
          {/* 保留页面实例，让长请求和草稿在导航切换后仍然有效。 */}
          <div hidden={section !== 'ask'} className="view-enter"><AskView /></div>
          <div hidden={section !== 'pipeline'} className="view-enter"><PipelineView /></div>
          <div hidden={section !== 'logs'} className="view-enter"><LogsView active={section === 'logs'} /></div>
        </main>
        <footer className="app-footer">
          <span>知序 · KNOWLEDGE PLATFORM</span>
          <span>让知识有迹可循</span>
        </footer>
      </div>
    </div>
  )
}
