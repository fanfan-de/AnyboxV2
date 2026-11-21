import type { CatalogStatus, ProviderModel, SourceRef } from '@anybox/models'

export function sourceLabel(source: SourceRef): string {
  return source.kind === 'user' ? '用户自定义' : `${source.sourceId} / ${source.providerId}`
}
export function providerModelAvailability(model: ProviderModel): string {
  if (model.available) return '可用'
  return { disabled: '模型已停用', 'provider-disabled': '提供方已停用', 'protocol-unavailable': '协议未安装',
    'credential-missing': '尚未配置 Key', 'invalid-configuration': '需要调整配置', 'protocol-unmapped': '当前协议不适用',
    'connection-mismatch': '当前 API 地址不适用', 'non-text': '当前不支持此模态', 'deprecated': '模型已弃用',
    missing: '来源已移除', unresolved: '来源尚未解析', 'definition-missing': '来源已移除', 'text-unsupported': '当前不支持此模态' }[model.unavailableReason ?? 'invalid-configuration'] ?? '当前不可用'
}
const statusErrors = {
  unavailable: '目录来源暂时不可用', 'invalid-response': '目录数据未通过校验',
  'storage-unavailable': '目录缓存无法持久保存', 'cleanup-failure': '目录请求资源未能正常退出', timeout: '目录检查超时',
}

export function directoryRefreshError(status: CatalogStatus): string | undefined {
  const reason = status.error ?? status.cache.error
  return reason ? statusErrors[reason] : undefined
}
