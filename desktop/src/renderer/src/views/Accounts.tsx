import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Plus, Trash2, Loader2, RotateCw, Pin, Zap } from 'lucide-react'
import { useTcStore } from '../store'
import type { TcEvent } from '../types'

export default function Accounts(): React.JSX.Element {
  const { config, status, events, refreshConfig, refreshStatus } = useTcStore()
  const [loggingIn, setLoggingIn] = useState(false)
  const accounts = (config as { accounts?: { name: string; type: string; orgName?: string | null; priority?: number; disabled?: boolean }[] } | null)?.accounts ?? []
  // Live per-account health comes from the STORE status, not the redacted config. Cross-reference by name.
  const statusOf = (name: string): string | undefined => status?.accounts?.find(a => a.name === name)?.status
  // The hand-pinned account (null = auto-rotation) comes from the live status too.
  const pinnedName = status?.manualAccount ?? null
  const pin = async (name: string | null): Promise<void> => {
    await window.tc.account.pin(name)
    await refreshStatus()
  }

  const lastOauth = [...events].reverse().find((e: TcEvent) => e.type.startsWith('oauth-'))
  const oauthBusy = loggingIn && lastOauth?.type !== 'oauth-complete' && lastOauth?.type !== 'oauth-error'

  // Start the browser OAuth flow. Shared by "Add account" and per-account "Re-login".
  // The proxy upserts by account identity, so logging in again as a broken account refreshes its tokens in place.
  const startLogin = async (): Promise<void> => {
    setLoggingIn(true)
    const r = await window.tc.api.oauthLogin()
    if (!r.ok) setLoggingIn(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{accounts.length} account(s)</h2>
        <Button size="sm" onClick={() => void startLogin()} disabled={oauthBusy}>
          {oauthBusy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add account
        </Button>
      </div>
      {lastOauth?.type === 'oauth-error' && (
        <p className="text-xs text-destructive">Login failed: {String(lastOauth.error)}</p>
      )}
      {oauthBusy && (
        <p className="text-xs text-muted-foreground">Complete the login in your browser…</p>
      )}
      {accounts.map(a => {
        const broken = statusOf(a.name) === 'error'
        return (
        <Card key={a.name} className={broken ? 'border-destructive/50' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
              <span className="truncate" title={a.name}>{a.name}</span>
              <Badge variant="secondary" className="shrink-0">{a.type}</Badge>
              {a.orgName && <Badge variant="outline" className="min-w-0 shrink-0 max-w-[40%]"><span className="truncate" title={a.orgName}>{a.orgName}</span></Badge>}
              {broken && <Badge variant="destructive" className="shrink-0">Needs re-login</Badge>}
              {pinnedName === a.name && <Badge className="shrink-0 gap-1"><Pin className="size-3" /> active — pinned</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {broken && (
              <p className="text-xs text-muted-foreground">Log in as this account in the browser to restore it.</p>
            )}
            <div className="flex items-center gap-3">
              <label className="flex shrink-0 items-center gap-2 text-xs">
                <Switch checked={!a.disabled}
                  onCheckedChange={async v => { await window.tc.config.setAccountDisabled(a.name, !v); await refreshConfig() }} />
                enabled
              </label>
              <label className="flex shrink-0 items-center gap-2 text-xs">
                priority
                <Input type="number" defaultValue={a.priority ?? 0} className="h-7 w-16"
                  onBlur={async e => { await window.tc.config.setAccountPriority(a.name, Number(e.target.value) || 0); await refreshConfig() }} />
              </label>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {pinnedName === a.name ? (
                  <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs"
                    aria-label={`Return ${a.name} to auto-rotation`} title="Return to auto-rotation"
                    onClick={() => void pin(null)}>
                    <Zap className="size-3.5" /> Auto
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" className="h-7 gap-1 px-2 text-xs"
                    aria-label={`Use ${a.name}`} title={`Pin ${a.name} as the active account`}
                    onClick={() => void pin(a.name)}>
                    <Pin className="size-3.5" /> Use
                  </Button>
                )}
                {(broken || a.type === 'oauth') && (
                  <Button variant={broken ? 'destructive' : 'ghost'} size="sm"
                    className="h-7 gap-1 px-2 text-xs" disabled={oauthBusy}
                    aria-label={`Re-login ${a.name}`} title={`Re-login as ${a.name}`}
                    onClick={() => void startLogin()}>
                    {oauthBusy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />} Re-login
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="shrink-0 text-destructive" aria-label={`Remove ${a.name}`}
                  onClick={async () => {
                    if (!window.confirm(`Remove account "${a.name}"? The proxy will restart.`)) return
                    await window.tc.config.removeAccount(a.name)
                    await refreshConfig()
                  }}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )})}
    </div>
  )
}
