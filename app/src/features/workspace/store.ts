import { create } from 'zustand'
import { ApiError, errorMessage, requestJson } from '@/utils/api'

export type Section = 'logs' | 'ask' | 'pipeline'
export interface ModelChoice { provider: string, model: string }
export interface KnowledgeBaseOption {
  id: string
  description: string
  embedding: (ModelChoice & { dimensions: number | null }) | null
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
  question: string
  options: WorkspaceOptions | null
  optionsPending: boolean
  optionsError: ApiError | null
  knowledgeBaseSaving: boolean
  refreshOptions: () => Promise<void>
  createKnowledgeBase: (name: string, description: string) => Promise<ApiError | null>
  updateKnowledgeBaseDescription: (id: string, description: string) => Promise<ApiError | null>
  setSection: (section: Section) => void
  setKnowledgeBaseId: (id: string) => void
  setQuestion: (question: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  section: 'ask',
  knowledgeBaseId: '',
  question: '',
  options: null,
  optionsPending: false,
  optionsError: null,
  knowledgeBaseSaving: false,
  async refreshOptions() {
    if (get().optionsPending || get().knowledgeBaseSaving)
      return
    set({ optionsPending: true, optionsError: null })
    try {
      const { data } = await requestJson<WorkspaceOptions>('/api/workspace/options')
      set(state => ({ options: data, knowledgeBaseId: state.knowledgeBaseId || data.knowledgeBases[0]?.id || '' }))
    }
    catch (error) {
      set({ optionsError: errorMessage(error) })
    }
    finally { set({ optionsPending: false }) }
  },
  async createKnowledgeBase(name, description) {
    const id = name.trim()
    if (!id || id.length > 64)
      return new ApiError('请输入 1–64 个字符的知识库名称。')
    if (get().options?.knowledgeBases.some(kb => kb.id === id))
      return new ApiError('已存在同名知识库，请换一个名称。')
    if (get().knowledgeBaseSaving || get().optionsPending)
      return new ApiError('正在更新知识库，请稍后再试。')
    set({ knowledgeBaseSaving: true })
    try {
      const { data } = await requestJson<{ id: string, description: string }>('/api/workspace/knowledge-bases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: id, description }) })
      // 创建成功即持久化；空库没有向量空间，首次入库仍可自由选择模型。
      set(state => ({ knowledgeBaseId: data.id, options: state.options ? { ...state.options, knowledgeBases: [...state.options.knowledgeBases, { ...data, embedding: null, documents: [] }] } : null }))
      return null
    }
    catch (error) { return errorMessage(error) }
    finally { set({ knowledgeBaseSaving: false }) }
  },
  async updateKnowledgeBaseDescription(id, description) {
    if (get().knowledgeBaseSaving || get().optionsPending)
      return new ApiError('正在更新知识库，请稍后再试。')
    set({ knowledgeBaseSaving: true })
    try {
      const { data } = await requestJson<{ id: string, description: string }>(`/api/workspace/knowledge-bases/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description }) })
      set(state => ({ options: state.options ? { ...state.options, knowledgeBases: state.options.knowledgeBases.map(kb => kb.id === data.id ? { ...kb, description: data.description } : kb) } : null }))
      return null
    }
    catch (error) { return errorMessage(error) }
    finally { set({ knowledgeBaseSaving: false }) }
  },
  setSection: section => set({ section }),
  setKnowledgeBaseId: knowledgeBaseId => set({ knowledgeBaseId }),
  setQuestion: question => set({ question }),
}))

export function selectedModel(value: ModelChoice | null, choices: ModelChoice[]) {
  return choices.find(item => item.provider === value?.provider && item.model === value.model) ?? choices[0]
}
