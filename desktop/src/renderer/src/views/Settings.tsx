import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Save } from 'lucide-react'

interface AppSettings {
  editorCommand: string; hotkey: string; launchAtLogin: boolean
  teamclaudeCommand: string; teamclaudeArgs: string[]
}

export default function Settings(): React.JSX.Element {
  const [s, setS] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { void window.tc.settings.get().then(v => setS(v as AppSettings)) }, [])
  if (!s) return <p className="text-sm text-muted-foreground">Loading…</p>

  const save = async (): Promise<void> => {
    await window.tc.settings.set(s)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  const field = (label: string, key: 'editorCommand' | 'hotkey' | 'teamclaudeCommand', mono = true): React.JSX.Element => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={s[key]} className={`h-7 ${mono ? 'font-mono' : ''}`}
        onChange={e => setS({ ...s, [key]: e.target.value })} />
    </div>
  )

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">App</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {field('Editor command (Trae CLI)', 'editorCommand')}
          {field('Toggle hotkey (Electron accelerator)', 'hotkey')}
          <div className="flex items-center justify-between">
            <Label className="text-xs">Launch at login</Label>
            <Switch checked={s.launchAtLogin} onCheckedChange={v => setS({ ...s, launchAtLogin: v })} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Proxy process</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {field('teamclaude command', 'teamclaudeCommand')}
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
    </div>
  )
}
