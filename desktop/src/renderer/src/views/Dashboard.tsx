import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Switch } from '@renderer/components/ui/switch'
import { RotateCw, Play, Square, Copy, Check } from 'lucide-react'
import { useTcStore } from '../store'
import QuotaBar from '../components/QuotaBar'

interface ProxyInfo { port: number; url: string; configPath: string }

function ConnectCard({ info }: { info: ProxyInfo }): React.JSX.Element {
  const [copied, setCopied] = useState('')
  const cmd = `set "ANTHROPIC_BASE_URL=${info.url}" && claude`
  const [auto, setAuto] = useState(false)
  useEffect(() => { void window.tc.proxy.getAutoRoute?.().then((r: { enabled: boolean }) => setAuto(r.enabled)).catch(() => {}) }, [])
  const toggleAuto = async (v: boolean): Promise<void> => { setAuto(v); await window.tc.proxy.setAutoRoute(v) }
  const copy = (text: string, key: string): void => {
    void navigator.clipboard?.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(''), 1200)
  }
  const Row = ({ text, k }: { text: string; k: string }): React.JSX.Element => (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]" title={text}>{text}</code>
      <Button size="sm" variant="outline" className="h-7 shrink-0 px-2" aria-label="Copy" onClick={() => copy(text, k)}>
        {copied === k ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </div>
  )
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Connect your Claude</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[11px] text-muted-foreground">This app runs its own proxy at:</p>
        <Row text={info.url} k="url" />
        <label className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2">
          <span className="min-w-0 text-xs">
            <span className="font-medium">Route my Claude through this</span>
            <span className="block text-[11px] text-muted-foreground">Sets ANTHROPIC_BASE_URL for new terminals — then just run <span className="font-mono">claude</span>.</span>
          </span>
          <Switch checked={auto} onCheckedChange={v => void toggleAuto(v)} />
        </label>
        <p className="text-[11px] text-muted-foreground">{auto ? 'On — open a NEW terminal and run claude; it routes here automatically.' : 'Or route one session manually:'}</p>
        {!auto && <Row text={cmd} k="cmd" />}
        <p className="text-[11px] text-muted-foreground">Then requests show up in Activity and the quota bars move.</p>
      </CardContent>
    </Card>
  )
}

export default function Dashboard(): React.JSX.Element {
  const { status, proxyState, events } = useTcStore()
  const [info, setInfo] = useState<ProxyInfo | null>(null)
  useEffect(() => { void window.tc.proxy.getInfo().then(setInfo).catch(() => {}) }, [])

  const recentEnds = events.filter(e => e.type === 'request-end').slice(-20)
  const uptime = status?.server ? Math.floor(status.server.uptimeSeconds / 60) : 0

  return (
    <div className="space-y-3">
      {info && <ConnectCard info={info} />}

      {!status ? (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Proxy is starting…</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              State: {proxyState}. If it stays down, use the buttons below.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void window.tc.proxy.start()}><Play className="size-4" /> Start</Button>
              <Button size="sm" variant="outline" onClick={() => void window.tc.proxy.restart()}><RotateCw className="size-4" /> Restart</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Active account</CardTitle></CardHeader>
            <CardContent className="space-y-1">
              <div className="truncate text-lg font-medium" title={status.currentAccount ?? undefined}>{status.currentAccount ?? '—'}</div>
              <div className="text-xs break-words text-muted-foreground">
                port {status.server?.port} · up {uptime}m · {proxyState} · {recentEnds.length} recent requests
              </div>
              <div className="flex gap-2 pt-2">
                <Button size="sm" variant="outline" onClick={() => void window.tc.api.reload()}>
                  <RotateCw className="size-4" /> Reload config
                </Button>
                <Button size="sm" variant="outline" onClick={() => void window.tc.proxy.stop()}>
                  <Square className="size-4" /> Stop proxy
                </Button>
              </div>
            </CardContent>
          </Card>

          {(status.accounts ?? []).map(a => (
            <Card key={a.name} className={a.name === status.currentAccount ? 'border-primary/50' : ''}>
              <CardHeader className="pb-2">
                <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate" title={a.name}>{a.name}</span>
                  {a.disabled && <Badge variant="outline" className="shrink-0">disabled</Badge>}
                  {a.status === 'error' && <Badge variant="destructive" className="shrink-0">error</Badge>}
                  {a.rateLimitedUntil && <Badge variant="destructive" className="shrink-0">rate-limited</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {a.quota.unified5h == null && a.quota.unified7d == null ? (
                  <p className="text-xs text-muted-foreground">Waiting for quota data…</p>
                ) : (
                  <>
                    {typeof a.quota.unified5h === 'number' && (
                      <QuotaBar label="Session" ratio={a.quota.unified5h} resetMs={a.quota.unified5hReset} />
                    )}
                    {typeof a.quota.unified7d === 'number' && (
                      <QuotaBar label="Weekly" ratio={a.quota.unified7d} resetMs={a.quota.unified7dReset} />
                    )}
                    {typeof a.quota.unified7dSonnet === 'number' && (
                      <QuotaBar label="Sonnet" ratio={a.quota.unified7dSonnet} resetMs={a.quota.unified7dSonnetReset} />
                    )}
                    {typeof a.quota.unified7dFable === 'number' && (
                      <QuotaBar label="Fable" ratio={a.quota.unified7dFable} resetMs={a.quota.unified7dFableReset} />
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  )
}
