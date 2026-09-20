import { create } from 'zustand'

export type Section = 'documents' | 'wiki' | 'ask' | 'pipeline'

interface WorkspaceState {
  section: Section
  documentQuery: string
  question: string
  setSection: (section: Section) => void
  setDocumentQuery: (query: string) => void
  setQuestion: (question: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>(set => ({
  section: 'documents',
  documentQuery: '',
  question: '',
  setSection: section => set({ section }),
  setDocumentQuery: documentQuery => set({ documentQuery }),
  setQuestion: question => set({ question }),
}))
