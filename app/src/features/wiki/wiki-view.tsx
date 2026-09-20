import { Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from '@/features/workspace/store'

export function WikiView() {
  const setSection = useWorkspaceStore(s => s.setSection)
  return (
    <>
      <div className="section-heading">
        <div>
          <div className="eyebrow">KNOWLEDGE NETWORK</div>
          <h1>
            Wiki 节点
            <span className="title-dot">.</span>
          </h1>
          <p>将文档中的概念与关联组织成可探索的知识网络。</p>
        </div>
        <span className="pending-note">0 个节点</span>
      </div>
      <div className="empty-state tall">
        <Network className="size-16 text-primary/60" strokeWidth={1} />
        <h2>知识连接，从这里生长</h2>
        <p>文档完成 Wiki 化后，节点及其关联将在这里呈现。</p>
        <span className="pending-note">Wiki 构建功能尚未接入</span>
        <Button variant="outline" onClick={() => setSection('documents')}>
          返回文档库
        </Button>
      </div>
    </>
  )
}
