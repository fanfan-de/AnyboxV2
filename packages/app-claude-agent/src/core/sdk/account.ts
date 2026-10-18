import type { AccountInfo, Query, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { AccountUsageView, QuotaWindow } from '../account.js'

const label = (value: unknown, limit = 200): string | null => typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : null
const windowView = (value: unknown): QuotaWindow | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as { utilization?: unknown; resets_at?: unknown }
  return {
    usedPercent: typeof raw.utilization === 'number' && Number.isFinite(raw.utilization) && raw.utilization >= 0 && raw.utilization <= 100 ? raw.utilization : null,
    resetsAt: typeof raw.resets_at === 'string' && Number.isFinite(Date.parse(raw.resets_at)) ? new Date(raw.resets_at).toISOString() : null,
  }
}
/** Missing windows are unknown, never inferred from token counts, cost, or another account's cached result. */
export function accountUsageView(account: AccountInfo | undefined, usage: SDKControlGetUsageResponse | undefined, checkedAt: string): AccountUsageView {
  const fiveHour = windowView(usage?.rate_limits?.five_hour), weekly = windowView(usage?.rate_limits?.seven_day)
  // An explicit null describes the active API/provider lane; do not resurrect a cached OAuth plan.
  const subscription = usage && 'subscription_type' in usage ? label(usage.subscription_type) : label(account?.subscriptionType)
  const provider = label(account?.apiProvider)
  const failed = !usage || typeof usage.rate_limits_available !== 'boolean'
  const available = !failed && usage.rate_limits_available && !!usage.rate_limits
  return {
    schemaVersion: 1, checkedAt,
    account: { email: label(account?.email, 320), organization: label(account?.organization), subscription, provider },
    accountError: account ? null : '账号信息读取失败，请检查当前执行设备的 Claude 登录状态后刷新。',
    quotas: {
      status: failed ? 'failed' : available ? 'available' : 'unavailable',
      reason: failed ? '额度读取失败，请检查当前执行设备的 Claude 登录状态与网络后刷新。' : available ? null :
        provider && provider !== 'firstParty' || account?.apiKeySource && !subscription ? '当前认证方式不提供 Claude 订阅额度；API 或云服务用量请到对应服务商查看。' : 'Claude 未提供此账号的订阅额度，可能缺少登录授权或当前认证方式不支持。请检查登录状态后刷新。',
      fiveHour: available ? fiveHour : null, weekly: available ? weekly : null,
    },
  }
}
/** The experimental API is isolated here; a failed quota request does not hide readable account metadata. */
export async function readAccountUsage(query: Pick<Query, 'accountInfo' | 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'>, timeoutMs = 8000): Promise<AccountUsageView> {
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('account-read-timeout')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  const [account, usage] = await Promise.allSettled([
    bounded(() => query.accountInfo()),
    bounded(() => query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })),
  ])
  return accountUsageView(account.status === 'fulfilled' ? account.value : undefined, usage.status === 'fulfilled' ? usage.value : undefined, new Date().toISOString())
}
