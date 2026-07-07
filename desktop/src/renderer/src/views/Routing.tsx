import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Plus, Trash2, Save } from 'lucide-react'
import { useTcStore } from '../store'

interface Route { name: string; match: string[]; accounts?: string[]; bucket?: string }

export default function Routing(): React.JSX.Element {
  const { status, refreshStatus } = useTcStore()
  const [routes, setRoutes] = useState<Route[]>([])
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setRoutes(status?.routes ?? []) }, [status, dirty])

  const edit = (i: number, patch: Partial<Route>): void => {
    setRoutes(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const save = async (): Promise<void> => {
    const clean = routes
      .filter(r => r.name.trim() && r.match.length)
      .map(r => ({ ...r, accounts: r.accounts?.length ? r.accounts : undefined, bucket: r.bucket || undefined }))
    await window.tc.config.setRoutes(clean)
    setDirty(false)
    await refreshStatus()
  }
  const csv = (v: string[] | undefined): string => (v ?? []).join(', ')
  const parse = (s: string): string[] => s.split(',').map(x => x.trim()).filter(Boolean)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">First matching route wins. Empty accounts = all accounts.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setRoutes(r => [...r, { name: '', match: [] }]); setDirty(true) }}>
            <Plus className="size-4" /> Route
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty}><Save className="size-4" /> Save</Button>
        </div>
      </div>
      {routes.map((r, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center text-sm">
              <Input value={r.name} placeholder="route name" className="h-7 w-40" onChange={e => edit(i, { name: e.target.value })} />
              <Button variant="ghost" size="icon" className="ml-auto text-destructive" aria-label="Delete route"
                onClick={() => { setRoutes(rs => rs.filter((_x, j) => j !== i)); setDirty(true) }}>
                <Trash2 className="size-4" />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="space-y-1">
              <Label className="text-xs">Model globs (comma-separated)</Label>
              <Input value={csv(r.match)} placeholder="claude-opus-*, claude-fable-*" className="h-7"
                onChange={e => edit(i, { match: parse(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Accounts (comma-separated names; empty = all)</Label>
              <Input value={csv(r.accounts)} className="h-7" onChange={e => edit(i, { accounts: parse(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Quota bucket (optional)</Label>
              <Input value={r.bucket ?? ''} className="h-7" onChange={e => edit(i, { bucket: e.target.value })} />
            </div>
          </CardContent>
        </Card>
      ))}
      {routes.length === 0 && <p className="text-sm text-muted-foreground">No routes — all models rotate across all accounts.</p>}
    </div>
  )
}
