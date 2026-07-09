import { useState } from 'react'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { FolderOpen, Plus, Trash2, ExternalLink } from 'lucide-react'
import { useTcStore } from '../store'

export default function Launcher(): React.JSX.Element {
  const { projects, refreshProjects } = useTcStore()
  const [error, setError] = useState<string | null>(null)

  const addProject = async (): Promise<void> => {
    const path = await window.tc.launcher.pickFolder()
    if (!path) return
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
    await window.tc.launcher.add({ path, name, autorun: null })
    await refreshProjects()
  }
  const open = async (path: string): Promise<void> => {
    setError(null)
    const r = await window.tc.launcher.open(path)
    if (!r.ok) setError(r.error ?? 'Failed to open editor')
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-2">
          <Button size="sm" className="w-full" onClick={() => void addProject()}>
            <Plus className="size-4" /> Add project folder
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Opens the folder in your editor. Terminals route through this proxy via
            auto-route (see Settings) — no per-project tasks are written.
          </p>
        </CardContent>
      </Card>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {projects.map(p => (
        <Card key={p.path}>
          <CardContent className="flex items-center gap-2">
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{p.name}</div>
              <div className="truncate text-xs text-muted-foreground">{p.path}</div>
            </div>
            <Button size="sm" className="ml-auto shrink-0" onClick={() => void open(p.path)}>
              <ExternalLink className="size-4" /> Open
            </Button>
            <Button variant="ghost" size="icon" className="shrink-0 text-destructive" aria-label={`Remove ${p.name}`}
              onClick={async () => { await window.tc.launcher.remove(p.path); await refreshProjects() }}>
              <Trash2 className="size-4" />
            </Button>
          </CardContent>
        </Card>
      ))}
      {projects.length === 0 && <p className="text-sm text-muted-foreground">No projects yet — add a folder to launch it in your editor.</p>}
    </div>
  )
}
