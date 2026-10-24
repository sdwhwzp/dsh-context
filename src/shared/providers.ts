/** The provider-id seam between dsh request envelopes and the models.dev registry; unmapped route keys pass through. */

const MODELS_DEV_PROVIDER_IDS: Record<string, string> = {
  // dsh's two native DeepSeek routes share one registry vendor: `deepseek-account` must resolve for the peak/off-peak split.
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek',
  'kimi-coding': 'moonshotai',
  'minimax-cn': 'minimax',
  'zai-coding-cn': 'zhipuai',
}

export function modelsDevProviderOf(dshProviderId: string): string {
  return MODELS_DEV_PROVIDER_IDS[dshProviderId] ?? dshProviderId
}

export function isDeepSeekProvider(dshProviderId: string): boolean {
  return modelsDevProviderOf(dshProviderId) === 'deepseek'
}
