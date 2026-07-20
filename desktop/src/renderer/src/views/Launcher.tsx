import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { FolderOpen, Plus, Trash2, ExternalLink, AppWindow } from 'lucide-react'
import { useTcStore } from '../store'

// Curated from the real `claude --help`. Booleans each map to one flag; selects
// emit `--<flag> <value>` when a non-"Default" value is chosen. Order here is the
// order tokens are composed into settings.claudeFlags (booleans first, then selects).
const BOOL_FLAGS = [
  { flag: '--dangerously-skip-permissions', label: 'Skip permission prompts' },
  { flag: '--continue', label: 'Continue last conversation' },
  { flag: '--ide', label: 'Auto-connect IDE' },
  { flag: '--safe-mode', label: 'Safe mode (disable customizations)' },
] as const

const SELECT_FLAGS = [
  { flag: '--model', label: 'Model', options: ['Default', 'fable', 'opus', 'sonnet', 'haiku'] },
  { flag: '--permission-mode', label: 'Permission mode', options: ['Default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'] },
  { flag: '--effort', label: 'Effort', options: ['Default', 'low', 'medium', 'high', 'xhigh', 'max'] },
] as const

type Bools = Record<string, boolean>
type Selects = Record<string, string>

const emptyBools = (): Bools => Object.fromEntries(BOOL_FLAGS.map(b => [b.flag, false]))
const emptySelects = (): Selects => Object.fromEntries(SELECT_FLAGS.map(s => [s.flag, 'Default']))

/** Compose UI state into a flat token array like ["--ide","--model","opus"]. */
function composeFlags(bools: Bools, selects: Selects): string[] {
  const out: string[] = []
  for (const { flag } of BOOL_FLAGS) if (bools[flag]) out.push(flag)
  for (const { flag } of SELECT_FLAGS) {
    const v = selects[flag]
    if (v && v !== 'Default') out.push(flag, v)
  }
  return out
}

/** Parse a stored token array back into UI state by scanning for known flags. */
function parseFlags(tokens: string[]): { bools: Bools; selects: Selects } {
  const bools = emptyBools()
  for (const { flag } of BOOL_FLAGS) bools[flag] = tokens.includes(flag)
  const selects = emptySelects()
  for (const { flag } of SELECT_FLAGS) {
    const i = tokens.indexOf(flag)
    const next = i >= 0 ? tokens[i + 1] : undefined
    selects[flag] = next ?? 'Default'
  }
  return { bools, selects }
}

export default function Launcher(): React.JSX.Element {
  const { projects, refreshProjects } = useTcStore()
  const [error, setError] = useState<string | null>(null)
  const [autoTerminal, setAutoTerminal] = useState(true)
  // Runs `teamclaude run` — identical to the CLI: it sets up the proxy/MITM
  // routing and account rotation itself, and forwards any Claude flags to
  // claude (see tc:launcher:open in src/main/ipc.ts).
  const [autorunCmd, setAutorunCmd] = useState('teamclaude run')

  // Claude launch options — a global default (stored in settings.claudeFlags)
  // appended to the auto-terminal's `claude` command for launcher-opened projects.
  const [bools, setBools] = useState<Bools>(emptyBools)
  const [selects, setSelects] = useState<Selects>(emptySelects)
  useEffect(() => {
    void window.tc.settings.get().then(s => {
      const tokens = (s as { claudeFlags?: string[] }).claudeFlags ?? []
      const parsed = parseFlags(tokens)
      setBools(parsed.bools)
      setSelects(parsed.selects)
    })
  }, [])
  const persist = (nextBools: Bools, nextSelects: Selects): void => {
    void window.tc.settings.set({ claudeFlags: composeFlags(nextBools, nextSelects) })
  }
  const setBool = (flag: string, val: boolean): void => {
    const next = { ...bools, [flag]: val }
    setBools(next)
    persist(next, selects)
  }
  const setSelect = (flag: string, val: string): void => {
    const next = { ...selects, [flag]: val }
    setSelects(next)
    persist(bools, next)
  }
  const preview = ['teamclaude run', ...composeFlags(bools, selects)].join(' ')

  const addProject = async (): Promise<void> => {
    const path = await window.tc.launcher.pickFolder()
    if (!path) return
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
    await window.tc.launcher.add({ path, name, autorun: autoTerminal ? autorunCmd : null })
    await refreshProjects()
  }
  const open = async (path: string): Promise<void> => {
    setError(null)
    const r = await window.tc.launcher.open(path)
    if (!r.ok) setError(r.error ?? 'Failed to open editor')
  }
  const openSynara = async (): Promise<void> => {
    setError(null)
    const r = await window.tc.launcher.openSynara()
    if (!r.ok) setError(r.error ?? 'Failed to open Synara')
  }

  return (
    <div className="space-y-3">
      <Button size="sm" variant="outline" className="w-full" onClick={() => void openSynara()}>
        <AppWindow className="size-4" /> Open Synara
      </Button>

      <Card>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Auto-open terminal running:</Label>
            <Switch checked={autoTerminal} onCheckedChange={setAutoTerminal} />
          </div>
          {autoTerminal && (
            <Input value={autorunCmd} onChange={e => setAutorunCmd(e.target.value)} className="h-7 font-mono" />
          )}
          <Button size="sm" className="w-full" onClick={() => void addProject()}>
            <Plus className="size-4" /> Add project folder
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Auto-terminal writes a .vscode/tasks.json (folderOpen task) that runs teamclaude run —
            Claude must launch through teamclaude to be fully routed. The task also fires when you
            open the folder manually in your editor. The editor asks once to allow automatic tasks.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="font-mono text-[10px] font-medium tracking-[0.1em] uppercase text-muted-foreground">Claude launch options</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {BOOL_FLAGS.map(b => (
            <div key={b.flag} className="flex items-center justify-between gap-2">
              <Label className="min-w-0 truncate text-xs">{b.label}</Label>
              <Switch checked={!!bools[b.flag]} onCheckedChange={v => setBool(b.flag, v)} />
            </div>
          ))}
          {SELECT_FLAGS.map(sel => (
            <div key={sel.flag} className="flex items-center justify-between gap-2">
              <Label className="min-w-0 truncate text-xs">{sel.label}</Label>
              <Select value={selects[sel.flag] ?? 'Default'} onValueChange={v => setSelect(sel.flag, v)}>
                <SelectTrigger size="sm" className="w-36 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sel.options.map(o => (
                    <SelectItem key={o} value={o}>{o}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
          <div className="min-w-0 truncate rounded bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {preview}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Applies to projects opened via the launcher (appended to the auto-terminal&apos;s teamclaude run command).
          </p>
        </CardContent>
      </Card>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {projects.map(p => (
        <Card key={p.path} className="group transition-colors hover:border-primary/30 hover:bg-primary/[0.03]">
          <CardContent className="flex items-center gap-2">
            <FolderOpen className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
            <div className="min-w-0">
              <div className="truncate font-serif text-sm font-normal tracking-tight">{p.name}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{p.path}{p.autorun ? ` · runs ${p.autorun}` : ''}</div>
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
      {projects.length === 0 && (
        <div className="space-y-1 rounded-2xl border border-dashed border-border px-4 py-8 text-center">
          <p className="font-serif text-sm font-normal tracking-tight">No projects yet.</p>
          <p className="font-mono text-[10px] tracking-[0.08em] uppercase text-muted-foreground">Add a folder to launch it in your editor</p>
        </div>
      )}
    </div>
  )
}
