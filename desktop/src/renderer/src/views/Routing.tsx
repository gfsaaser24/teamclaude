import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Badge } from '@renderer/components/ui/badge'
import { Plus, Trash2, Save, X, ChevronDown, ChevronRight, Route as RouteIcon } from 'lucide-react'
import { useTcStore } from '../store'
import type { TcEvent } from '../types'

interface Route { name: string; match: string[]; accounts?: string[]; bucket?: string }

// Model-family glob presets — click to add the matching glob without knowing
// the exact versioned model id.
const PRESETS: { label: string; glob: string }[] = [
  { label: 'Opus', glob: 'claude-opus-*' },
  { label: 'Sonnet', glob: 'claude-sonnet-*' },
  { label: 'Haiku', glob: 'claude-haiku-*' },
  { label: 'Fable', glob: 'claude-fable-*' },
  { label: 'All Claude', glob: 'claude-*' },
]

// Distinct model ids actually observed in the live event stream, newest first.
function observedModels(events: TcEvent[]): string[] {
  const seen: string[] = []
  for (let i = events.length - 1; i >= 0 && seen.length < 12; i--) {
    const m = events[i].model
    if (typeof m === 'string' && m && !seen.includes(m)) seen.push(m)
  }
  return seen
}

export default function Routing(): React.JSX.Element {
  const { status, events, refreshStatus } = useTcStore()
  const [routes, setRoutes] = useState<Route[]>([])
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setRoutes(status?.routes ?? []) }, [status, dirty])

  const accounts = status?.accounts ?? []
  const observed = useMemo(() => observedModels(events), [events])

  const edit = (i: number, patch: Partial<Route>): void => {
    setRoutes(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const addRoute = (): void => {
    setRoutes(r => [...r, { name: `route-${r.length + 1}`, match: [], accounts: [] }])
    setDirty(true)
  }
  const removeRoute = (i: number): void => {
    setRoutes(rs => rs.filter((_x, j) => j !== i)); setDirty(true)
  }
  const save = async (): Promise<void> => {
    const clean = routes
      .filter(r => r.name.trim() && r.match.length)
      .map(r => ({
        name: r.name.trim(),
        match: r.match,
        accounts: r.accounts?.length ? r.accounts : undefined,
        bucket: r.bucket?.trim() || undefined,
      }))
    await window.tc.config.setRoutes(clean)
    setDirty(false)
    await refreshStatus()
  }

  const incomplete = routes.some(r => r.name.trim() && r.match.length === 0)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          Send specific models to specific accounts. First matching route wins.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={addRoute}><Plus className="size-4" /> Route</Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || incomplete}>
            <Save className="size-4" /> Save
          </Button>
        </div>
      </div>

      {routes.length === 0 && (
        <Card>
          <CardContent className="space-y-2 py-6 text-center">
            <RouteIcon className="mx-auto size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No routes yet</p>
            <p className="mx-auto max-w-[46ch] text-xs text-muted-foreground">
              Right now every model rotates across all your accounts. Add a route to pin a model
              to specific accounts — e.g. send <span className="font-mono">Opus</span> only to your Max accounts
              so it never spends your API key.
            </p>
            <Button size="sm" className="mt-1" onClick={addRoute}><Plus className="size-4" /> Add your first route</Button>
          </CardContent>
        </Card>
      )}

      {routes.map((r, i) => (
        <RouteEditor
          key={i}
          route={r}
          accounts={accounts.map(a => ({ name: a.name, type: a.type, org: a.orgName }))}
          observed={observed}
          onChange={patch => edit(i, patch)}
          onRemove={() => removeRoute(i)}
        />
      ))}
    </div>
  )
}

function RouteEditor({ route, accounts, observed, onChange, onRemove }: {
  route: Route
  accounts: { name: string; type: string; org: string | null }[]
  observed: string[]
  onChange: (patch: Partial<Route>) => void
  onRemove: () => void
}): React.JSX.Element {
  const [custom, setCustom] = useState('')
  const [advanced, setAdvanced] = useState(!!route.bucket)

  const addModel = (glob: string): void => {
    const g = glob.trim()
    if (g && !route.match.includes(g)) onChange({ match: [...route.match, g] })
  }
  const removeModel = (g: string): void => onChange({ match: route.match.filter(x => x !== g) })
  const toggleAccount = (name: string): void => {
    const set = new Set(route.accounts ?? [])
    if (set.has(name)) set.delete(name); else set.add(name)
    onChange({ accounts: [...set] })
  }

  const selectedAccounts = route.accounts ?? []
  const summary =
    route.match.length === 0 ? 'Pick at least one model'
      : `${route.match.join(', ')} → ${selectedAccounts.length === 0 ? 'all accounts' : `${selectedAccounts.length} of ${accounts.length} account${accounts.length === 1 ? '' : 's'}`}`

  // Presets not already added.
  const availablePresets = PRESETS.filter(p => !route.match.includes(p.glob))
  const availableObserved = observed.filter(m => !route.match.includes(m))

  return (
    <Card>
      <CardContent className="space-y-3">
        {/* Name + delete */}
        <div className="flex min-w-0 items-center gap-2">
          <Input
            value={route.name}
            placeholder="route name"
            className="h-8 min-w-0 flex-1"
            onChange={e => onChange({ name: e.target.value })}
          />
          <Button variant="ghost" size="icon" className="shrink-0 text-destructive" aria-label="Delete route" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>

        {/* Models */}
        <div className="space-y-1.5">
          <Label className="text-xs">Models</Label>
          {route.match.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {route.match.map(m => (
                <Badge key={m} variant="secondary" className="max-w-full gap-1 pr-1 font-mono text-[11px]">
                  <span className="truncate" title={m}>{m}</span>
                  <button className="app-no-drag shrink-0 rounded-sm opacity-60 hover:opacity-100" aria-label={`Remove ${m}`} onClick={() => removeModel(m)}>
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {availablePresets.map(p => (
              <Button key={p.glob} size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => addModel(p.glob)}>
                <Plus className="size-3" /> {p.label}
              </Button>
            ))}
          </div>
          {availableObserved.length > 0 && (
            <div className="space-y-1 pt-0.5">
              <p className="text-[11px] text-muted-foreground">Seen in your traffic — click to route the exact model:</p>
              <div className="flex flex-wrap gap-1.5">
                {availableObserved.map(m => (
                  <Button key={m} size="sm" variant="ghost" className="h-6 max-w-full px-2 font-mono text-[11px]" title={m} onClick={() => addModel(m)}>
                    <span className="truncate">{m}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-1.5 pt-0.5">
            <Input
              value={custom}
              placeholder="custom glob, e.g. claude-3-*"
              className="h-7 min-w-0 flex-1 font-mono text-[11px]"
              onChange={e => setCustom(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { addModel(custom); setCustom('') } }}
            />
            <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={() => { addModel(custom); setCustom('') }} disabled={!custom.trim()}>
              Add
            </Button>
          </div>
        </div>

        {/* Accounts */}
        <div className="space-y-1.5">
          <Label className="text-xs">Accounts</Label>
          {accounts.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No accounts loaded — start the proxy to pick accounts.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {accounts.map(a => {
                const on = selectedAccounts.includes(a.name)
                return (
                  <Button
                    key={a.name}
                    size="sm"
                    variant={on ? 'default' : 'outline'}
                    className="h-7 max-w-full px-2 text-[11px]"
                    title={`${a.name}${a.org ? ` (${a.org})` : ''} · ${a.type}`}
                    onClick={() => toggleAccount(a.name)}
                  >
                    <span className="truncate">{a.name}</span>
                  </Button>
                )
              })}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {selectedAccounts.length === 0 ? 'None selected → this model can use all accounts.' : 'Only the selected accounts will serve these models.'}
          </p>
        </div>

        {/* Advanced: bucket */}
        <div>
          <button className="app-no-drag flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setAdvanced(v => !v)}>
            {advanced ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Advanced
          </button>
          {advanced && (
            <div className="space-y-1 pt-1.5">
              <Label className="text-xs">Quota bucket (optional)</Label>
              <Input value={route.bucket ?? ''} placeholder="leave empty unless you know you need it" className="h-7 text-[11px]"
                onChange={e => onChange({ bucket: e.target.value })} />
              <p className="text-[11px] text-muted-foreground">Overrides which quota window this route counts against. Most setups leave this blank.</p>
            </div>
          )}
        </div>

        {/* Plain-English summary */}
        <div className="rounded-md border border-dashed px-2.5 py-1.5">
          <p className="min-w-0 break-words text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">This route: </span>{summary}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
