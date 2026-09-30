import { readWorkspaceCatalog } from '../dao/workspace-options.js'
import { configuredModels } from './model-options.js'

export async function workspaceOptions() {
  return { ...await readWorkspaceCatalog(), models: configuredModels() }
}
