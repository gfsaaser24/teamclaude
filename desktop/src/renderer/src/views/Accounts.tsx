import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { useTcStore } from '../store'
import type { TcEvent } from '../types'

export default function Accounts(): React.JSX.Element {
  const { config, events, refreshConfig } = useTcStore()
  const [loggingIn, setLoggingIn] = useState(false)
  const accounts = (config as { accounts?: { name: string; type: string; orgName?: string | null; priority?: number; disabled?: boolean }[] } | null)?.accounts ?? []

  const lastOauth = [...events].reverse().find((e: TcEvent) => e.type.startsWith('oauth-'))
  const oauthBusy = loggingIn && lastOauth?.type !== 'oauth-complete' && lastOauth?.type !== 'oauth-error'

  const addAccount = async (): Promise<void> => {
    setLoggingIn(true)
    const r = await window.tc.api.oauthLogin()
    if (!r.ok) setLoggingIn(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{accounts.length} account(s)</h2>
        <Button size="sm" onClick={() => void addAccount()} disabled={oauthBusy}>
          {oauthBusy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add account
        </Button>
      </div>
      {lastOauth?.type === 'oauth-error' && (
        <p className="text-xs text-destructive">Login failed: {String(lastOauth.error)}</p>
      )}
      {oauthBusy && (
        <p className="text-xs text-muted-foreground">Complete the login in your browser…</p>
      )}
      {accounts.map(a => (
        <Card key={a.name}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {a.name}
              <Badge variant="secondary">{a.type}</Badge>
              {a.orgName && <Badge variant="outline">{a.orgName}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={!a.disabled}
                onCheckedChange={async v => { await window.tc.config.setAccountDisabled(a.name, !v); await refreshConfig() }} />
              enabled
            </label>
            <label className="flex items-center gap-2 text-xs">
              priority
              <Input type="number" defaultValue={a.priority ?? 0} className="h-7 w-16"
                onBlur={async e => { await window.tc.config.setAccountPriority(a.name, Number(e.target.value) || 0); await refreshConfig() }} />
            </label>
            <Button variant="ghost" size="icon" className="ml-auto text-destructive" aria-label={`Remove ${a.name}`}
              onClick={async () => {
                if (!window.confirm(`Remove account "${a.name}"? The proxy will restart.`)) return
                await window.tc.config.removeAccount(a.name)
                await refreshConfig()
              }}>
              <Trash2 className="size-4" />
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
