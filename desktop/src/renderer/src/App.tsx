import { useEffect, useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Pin, PinOff, X, ChevronUp, ChevronDown, Minimize2, Maximize2, Minus } from 'lucide-react'
import { useTcStore } from './store'
import Logo from './components/Logo'
import Onboarding from './onboarding/Onboarding'
import Dashboard from './views/Dashboard'
import Accounts from './views/Accounts'
import Routing from './views/Routing'
import Activity from './views/Activity'
import Launcher from './views/Launcher'
import Settings from './views/Settings'

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
  const [tabsCollapsed, setTabsCollapsed] = useState(false)
  const [compact, setCompactState] = useState(false)
  const [tab, setTab] = useState('dashboard')
  // null = not yet resolved (avoids a flash of the tabs before we know); true =
  // first run, show the walkthrough instead of the app.
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null)
  useEffect(() => { void init() }, [init])
  useEffect(() => {
    void window.tc.settings.get()
      .then((s: { onboarded?: boolean }) => setShowOnboarding(!s?.onboarded))
      .catch(() => setShowOnboarding(false))
  }, [])

  // Compact/HUD mode: shrink the OS window to a small HUD and strip the chrome
  // down to the active-account block. Forces the Home tab so the meters show,
  // collapses the tab strip, and drives the window resize in the main process.
  const toggleCompact = (): void => {
    const next = !compact
    setCompactState(next)
    setTabsCollapsed(next)
    if (next) setTab('dashboard')
    void window.tc.window.setCompact(next)
  }

  const badge = STATE_BADGE[proxyState] ?? STATE_BADGE.stopped
  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background/95 text-foreground">
      <header className="app-drag flex shrink-0 items-center gap-1.5 border-b px-3 py-2.5">
        <Logo size={18} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">TeamClaude</span>
        <Badge variant={badge.variant} className="shrink-0">{badge.label}</Badge>
        <div className="app-no-drag flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-sm"
            aria-label={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
            title={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
            onClick={() => setTabsCollapsed(v => !v)}>
            {tabsCollapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Minimize to taskbar"
            title="Minimize to taskbar" onClick={() => void window.tc.window.minimize()}>
            <Minus className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm"
            aria-label={compact ? 'Exit compact mode' : 'Compact HUD mode'}
            title={compact ? 'Exit compact mode' : 'Compact HUD mode'}
            onClick={toggleCompact}>
            {compact ? <Maximize2 className="size-4" /> : <Minimize2 className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Pin panel"
            onClick={() => { const next = !pinned; setPinnedState(next); void window.tc.window.setPinned(next) }}>
            {pinned ? <Pin className="size-4" /> : <PinOff className="size-4 opacity-50" />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Hide panel" onClick={() => void window.tc.window.hide()}>
            <X className="size-4" />
          </Button>
        </div>
      </header>
      {showOnboarding === null ? (
        <div className="min-h-0 flex-1" />
      ) : showOnboarding ? (
        <Onboarding onDone={() => setShowOnboarding(false)} />
      ) : (
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        {!tabsCollapsed && (
          <div className="px-3 pt-3">
            <TabsList className="h-auto w-full flex-wrap">
              <TabsTrigger value="dashboard">Home</TabsTrigger>
              <TabsTrigger value="accounts">Accounts</TabsTrigger>
              <TabsTrigger value="routing">Routes</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="launcher">Projects</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <TabsContent value="dashboard"><Dashboard compact={compact} /></TabsContent>
          <TabsContent value="accounts"><Accounts /></TabsContent>
          <TabsContent value="routing"><Routing /></TabsContent>
          <TabsContent value="activity"><Activity /></TabsContent>
          <TabsContent value="launcher"><Launcher /></TabsContent>
          <TabsContent value="settings"><Settings /></TabsContent>
        </div>
      </Tabs>
      )}
    </div>
  )
}
