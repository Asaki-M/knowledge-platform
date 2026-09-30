import type { ModelChoice } from './store'
import { selectedModel, useWorkspaceStore } from './store'

export type { ModelChoice } from './store'

export function ModelFields({ value, onChange, embedding = false }: { value: ModelChoice | null, onChange: (value: ModelChoice) => void, embedding?: boolean }) {
  const { options, optionsPending } = useWorkspaceStore()
  const choices = options?.models[embedding ? 'embedding' : 'llm'] ?? []
  const selected = selectedModel(value, choices)
  const key = (item: ModelChoice) => JSON.stringify([item.provider, item.model])
  return (
    <label className="field">
      <span>{embedding ? '向量模型' : '回答 / 提取模型'}</span>
      <select
        value={selected ? key(selected) : ''}
        disabled={optionsPending || !choices.length}
        onChange={(e) => {
          const choice = choices.find(item => key(item) === e.target.value)
          if (choice)
            onChange(choice)
        }}
      >
        {!choices.length && <option value="">{optionsPending ? '正在加载…' : '暂无已配置的模型'}</option>}
        {choices.map(item => <option key={key(item)} value={key(item)}>{`${item.provider} / ${item.model}`}</option>)}
      </select>
    </label>
  )
}
