import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Save, Copy, Check } from 'lucide-react'

interface AppSettings {
  editorCommand: string; hotkey: string; launchAtLogin: boolean
  teamclaudeCommand: string; teamclaudeArgs: string[]
  showDock?: boolean
  dockOpacity?: number
}

interface ProxyInfo { port: number; url: string; configPath: string }

// Moved here from the Home tab: how a user points their `claude` at this app's
// proxy — the one-time env var (auto-route) or a per-session command. Behaviour
// is identical to before; it just lives in Settings now so Home can be a HUD.
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

export default function Settings(): React.JSX.Element {
  const [s, setS] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)
  const [info, setInfo] = useState<ProxyInfo | null>(null)
  useEffect(() => { void window.tc.settings.get().then(v => setS(v as AppSettings)) }, [])
  useEffect(() => { void window.tc.proxy.getInfo().then(setInfo).catch(() => {}) }, [])

  const save = async (): Promise<void> => {
    if (!s) return
    await window.tc.settings.set(s)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  const field = (settings: AppSettings, label: string, key: 'editorCommand' | 'hotkey' | 'teamclaudeCommand', mono = true): React.JSX.Element => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={settings[key]} className={`h-7 ${mono ? 'font-mono' : ''}`}
        onChange={e => setS({ ...settings, [key]: e.target.value })} />
    </div>
  )

  return (
    <div className="space-y-3">
      {info && <ConnectCard info={info} />}
      {!s ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">App</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {field(s, 'Editor command (Trae CLI)', 'editorCommand')}
              {field(s, 'Toggle hotkey (Electron accelerator)', 'hotkey')}
              <div className="flex items-center justify-between">
                <Label className="text-xs">Launch at login</Label>
                <Switch checked={s.launchAtLogin} onCheckedChange={v => setS({ ...s, launchAtLogin: v })} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label className="min-w-0 text-xs">
                  Show edge dock (micro-HUD)
                  <span className="block text-[11px] font-normal text-muted-foreground">Always-on-top gauges pinned to the right screen edge.</span>
                </Label>
                <Switch checked={!!s.showDock} onCheckedChange={v => {
                  setS({ ...s, showDock: v })
                  void window.tc.settings.set({ showDock: v })
                  void window.tc.dock.toggle(v)
                }} />
              </div>
              {/* Transparency — whole-window opacity of the edge dock. Live-applies
                  as you drag; only meaningful while the dock is on. */}
              <div className={`space-y-1.5 ${s.showDock ? '' : 'opacity-50'}`}>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Dock transparency</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {Math.round((s.dockOpacity ?? 0.92) * 100)}%
                  </span>
                </div>
                <input
                  type="range" min="0.25" max="1" step="0.01"
                  aria-label="Dock transparency"
                  value={s.dockOpacity ?? 0.92}
                  disabled={!s.showDock}
                  onChange={e => {
                    const v = Number(e.target.value)
                    setS({ ...s, dockOpacity: v })
                    void window.tc.settings.set({ dockOpacity: v })
                    void window.tc.dock.setOpacity(v)
                  }}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 outline-none
                             disabled:cursor-not-allowed disabled:opacity-60
                             [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none
                             [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary
                             [&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:ring-1
                             [&::-webkit-slider-thumb]:ring-black/30 [&::-webkit-slider-thumb]:transition-transform
                             [&::-webkit-slider-thumb]:hover:scale-110"
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Proxy process</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {field(s, 'teamclaude command', 'teamclaudeCommand')}
              <div className="space-y-1">
                <Label className="text-xs">Arguments (space-separated)</Label>
                <Input value={s.teamclaudeArgs.join(' ')} className="h-7 font-mono"
                  onChange={e => setS({ ...s, teamclaudeArgs: e.target.value.split(/\s+/).filter(Boolean) })} />
              </div>
              <p className="text-[11px] break-words text-muted-foreground">
                Dev checkout example: command <code>node</code>, args <code className="break-all">C:\code\teamclaude\src\index.js server --headless</code>.
                Command changes apply on the next proxy restart.
              </p>
            </CardContent>
          </Card>
          <Button size="sm" onClick={() => void save()}><Save className="size-4" /> {saved ? 'Saved' : 'Save settings'}</Button>
        </>
      )}
    </div>
  )
}
