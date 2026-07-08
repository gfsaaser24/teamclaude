import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { RotateCw, Play, Square } from 'lucide-react'
import { useTcStore } from '../store'
import QuotaBar from '../components/QuotaBar'

export default function Dashboard(): React.JSX.Element {
  const { status, proxyState, events } = useTcStore()

  if (!status) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Proxy is not reachable</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <Button size="sm" onClick={() => void window.tc.proxy.start()}><Play className="size-4" /> Start</Button>
          <Button size="sm" variant="outline" onClick={() => void window.tc.proxy.restart()}><RotateCw className="size-4" /> Restart</Button>
        </CardContent>
      </Card>
    )
  }

  const recentEnds = events.filter(e => e.type === 'request-end').slice(-20)
  const uptime = status.server ? Math.floor(status.server.uptimeSeconds / 60) : 0

  return (
    <div className="space-y-3">
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
            {Object.entries(a.quota ?? {}).map(([bucket, q]) => (
              <QuotaBar key={bucket} label={bucket} utilization={q?.utilization} resetsAt={q?.resetsAt} />
            ))}
            {Object.keys(a.quota ?? {}).length === 0 && (
              <p className="text-xs text-muted-foreground">No quota observed yet</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
