/** Public account metadata only. Credentials and raw provider errors stay in the SDK adapter. */
export interface QuotaWindow {
  readonly usedPercent: number | null
  readonly resetsAt: string | null
}
export interface AccountUsageView {
  readonly schemaVersion: 1
  readonly checkedAt: string
  readonly account: {
    readonly email: string | null
    readonly organization: string | null
    readonly subscription: string | null
    readonly provider: string | null
  }
  readonly accountError: string | null
  readonly quotas: {
    readonly status: 'available' | 'unavailable' | 'failed'
    readonly reason: string | null
    readonly fiveHour: QuotaWindow | null
    readonly weekly: QuotaWindow | null
  }
}
