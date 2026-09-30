import type { ApiError } from '@/utils/api'
import { create } from 'zustand'
import { errorMessage, requestJson } from '@/utils/api'

export type Section = 'logs' | 'ask' | 'pipeline'
export interface ModelChoice { provider: string, model: string }
export interface KnowledgeBaseOption {
  id: string
  embedding: ModelChoice & { dimensions: number | null }
  documents: { id: string, label: string }[]
}
interface WorkspaceOptions {
  models: { llm: ModelChoice[], embedding: ModelChoice[] }
  knowledgeBases: KnowledgeBaseOption[]
  logScopes: { knowledgeBaseId: string, documentId: string | null }[]
}
interface WorkspaceState {
  section: Section
  knowledgeBaseId: string
  drafts: string[]
  question: string
  options: WorkspaceOptions | null
  optionsPending: boolean
  optionsError: ApiError | null
  refreshOptions: () => Promise<void>
  createKnowledgeBase: (name: string) => string | null
  setSection: (section: Section) => void
  setKnowledgeBaseId: (id: string) => void
  setQuestion: (question: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  section: 'ask',
  knowledgeBaseId: '',
  drafts: [],
  question: '',
  options: null,
  optionsPending: false,
  optionsError: null,
  async refreshOptions() {
    if (get().optionsPending)
      return
    set({ optionsPending: true, optionsError: null })
    try {
      const { data } = await requestJson<WorkspaceOptions>('/api/workspace/options')
      set(state => ({ options: data, drafts: state.drafts.filter(id => !data.knowledgeBases.some(kb => kb.id === id)), knowledgeBaseId: state.knowledgeBaseId || data.knowledgeBases[0]?.id || '' }))
    }
    catch (error) {
      set({ optionsError: errorMessage(error) })
    }
    finally { set({ optionsPending: false }) }
  },
  createKnowledgeBase(name) {
    const id = name.trim()
    if (!id || id.length > 64)
      return '请输入 1–64 个字符的知识库名称。'
    if (get().drafts.includes(id) || get().options?.knowledgeBases.some(kb => kb.id === id))
      return '已存在同名知识库，请换一个名称。'
    // 沿用服务端字符串标识契约，名称即知识库标识；首次入库后可从目录恢复。
    set(state => ({ knowledgeBaseId: id, drafts: [...state.drafts, id] }))
    return null
  },
  setSection: section => set({ section }),
  setKnowledgeBaseId: knowledgeBaseId => set({ knowledgeBaseId }),
  setQuestion: question => set({ question }),
}))

export function selectedModel(value: ModelChoice | null, choices: ModelChoice[]) {
  return choices.find(item => item.provider === value?.provider && item.model === value.model) ?? choices[0]
}
