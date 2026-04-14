type AgentModel = {
  providerID: string
  modelID: string
}

type Agent = {
  model?: AgentModel
  variant?: string
}

type Model = AgentModel & {
  variants?: Record<string, { disabled?: boolean }>
}

export function getConfiguredAgentVariant(agent: Agent | undefined, model: Model | undefined) {
  if (!agent?.variant) return undefined
  if (!agent.model) return undefined
  if (!model?.variants) return undefined
  if (agent.model.providerID !== model.providerID) return undefined
  if (agent.model.modelID !== model.modelID) return undefined
  const entry = model.variants[agent.variant]
  if (!entry || entry.disabled) return undefined
  return agent.variant
}

export function resolveModelVariant(
  selected: string | null | undefined,
  configured: string | undefined,
  variants: string[],
) {
  if (selected === null) return undefined
  if (selected && variants.includes(selected)) return selected
  if (configured && variants.includes(configured)) return configured
  return undefined
}

export function cycleModelVariant(
  selected: string | null | undefined,
  configured: string | undefined,
  variants: string[],
) {
  if (variants.length === 0) return undefined
  if (selected === null) return variants[0]
  if (selected && variants.includes(selected)) {
    const index = variants.indexOf(selected)
    if (index === variants.length - 1) return undefined
    return variants[index + 1]
  }
  if (configured && variants.includes(configured)) {
    const index = variants.indexOf(configured)
    if (index === variants.length - 1) return variants[0]
    return variants[index + 1]
  }
  return variants[0]
}
