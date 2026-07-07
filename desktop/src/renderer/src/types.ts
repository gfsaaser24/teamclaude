export interface TcEvent { id: number; type: string; ts: number; [k: string]: unknown }
export interface TcAccountStatus {
  name: string; type: string; orgName: string | null; priority: number
  disabled: boolean; status: string
  quota: Record<string, { utilization?: number; resetsAt?: string } | undefined>
  usage: Record<string, unknown>
  rateLimitedUntil: string | null
}
export interface TcStatus {
  currentAccount?: string
  switchThreshold?: number
  routes?: { name: string; match: string[]; accounts?: string[]; bucket?: string }[]
  accounts?: TcAccountStatus[]
  server?: { startedAt: string; uptimeSeconds: number; port: number; upstream: string }
  probe?: unknown
  warm?: unknown
}
export type SupervisorState = 'stopped' | 'starting' | 'running' | 'attached' | 'crashed'
