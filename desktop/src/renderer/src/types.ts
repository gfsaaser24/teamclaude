export interface TcEvent { id: number; type: string; ts: number; [k: string]: unknown }
export interface TcAccountStatus {
  name: string; type: string; orgName: string | null; priority: number
  disabled: boolean; status: string
  // Phase-0 §5b identity fields: stable account id (UUID+org) + email. Present
  // on newer servers; undefined against an older one (fall back to name).
  id?: string; email?: string
  quota: {
    unified5h: number | null; unified5hReset: number | null
    unified7d: number | null; unified7dReset: number | null
    unified7dSonnet: number | null; unified7dSonnetReset: number | null
    unified7dFable: number | null; unified7dFableReset: number | null
    [k: string]: unknown
  }
  usage: Record<string, unknown>
  rateLimitedUntil: string | null
}
export interface TcStatus {
  currentAccount?: string
  manualAccount?: string | null
  switchThreshold?: number
  routes?: { name: string; match: string[]; accounts?: string[]; bucket?: string }[]
  accounts?: TcAccountStatus[]
  server?: { startedAt: string; uptimeSeconds: number; port: number; upstream: string }
  probe?: unknown
  warm?: unknown
}
export type SupervisorState = 'stopped' | 'starting' | 'running' | 'attached' | 'crashed'
