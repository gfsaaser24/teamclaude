import { useEffect, useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Pin, PinOff, X } from 'lucide-react'
import { useTcStore } from './store'
import Dashboard from './views/Dashboard'
import Accounts from './views/Accounts'

const STATE_BADGE: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  running: { label: 'running', variant: 'default' },
  attached: { label: 'attached', variant: 'secondary' },
  starting: { label: 'starting…', variant: 'outline' },
  crashed: { label: 'crashed', variant: 'destructive' },
  stopped: { label: 'stopped', variant: 'destructive' },
}

export default function App(): React.JSX.Element {
  const { proxyState, init } = useTcStore()
  const [pinned, setPinnedState] = useState(false)
  useEffect(() => { void init() }, [init])

  const badge = STATE_BADGE[proxyState] ?? STATE_BADGE.stopped
  return (
    <div className="flex h-screen flex-col bg-background/95 text-foreground">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <span className="text-sm font-semibold tracking-tight">TeamClaude</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Pin panel"
            onClick={() => { const next = !pinned; setPinnedState(next); void window.tc.window.setPinned(next) }}>
            {pinned ? <Pin className="size-4" /> : <PinOff className="size-4 opacity-50" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Hide panel" onClick={() => void window.tc.window.hide()}>
            <X className="size-4" />
          </Button>
        </div>
      </header>
      <Tabs defaultValue="dashboard" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3">
          <TabsTrigger value="dashboard">Home</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="routing">Routes</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="launcher">Projects</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TabsContent value="dashboard"><Dashboard /></TabsContent>
          <TabsContent value="accounts"><Accounts /></TabsContent>
          <TabsContent value="routing"><p className="text-sm text-muted-foreground">Coming in a later task</p></TabsContent>
          <TabsContent value="activity"><p className="text-sm text-muted-foreground">Coming in a later task</p></TabsContent>
          <TabsContent value="launcher"><p className="text-sm text-muted-foreground">Coming in a later task</p></TabsContent>
          <TabsContent value="settings"><p className="text-sm text-muted-foreground">Coming in a later task</p></TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
