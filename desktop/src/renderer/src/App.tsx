import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { Button } from '@renderer/components/ui/button'
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

// Proxy state → mono uppercase eyebrow chip. Emerald = healthy (running /
// attached), amber = transitional (starting), red = down (crashed / stopped).
// Clay is the identity accent only — it never signals proxy health.
const STATE_CHIP: Record<string, { label: string; className: string }> = {
  running: { label: 'running', className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-400' },
  attached: { label: 'attached', className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-400' },
  starting: { label: 'starting', className: 'border-amber-400/25 bg-amber-400/10 text-amber-400' },
  crashed: { label: 'crashed', className: 'border-red-400/30 bg-red-400/10 text-red-400' },
  stopped: { label: 'stopped', className: 'border-red-400/30 bg-red-400/10 text-red-400' },
}

const NAV_TABS = [
  { value: 'dashboard', label: 'Home' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'routing', label: 'Routes' },
  { value: 'activity', label: 'Activity' },
  { value: 'launcher', label: 'Projects' },
  { value: 'settings', label: 'Settings' },
] as const

// Fade/slide-in for a freshly selected tab view. Radix unmounts inactive
// content, so this plays exactly once per tab switch — no exit animation.
function ViewFade({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}

export default function App(): React.JSX.Element {
  const { proxyState, init } = useTcStore()
  // Pin = always-on-top (the window itself starts on top, so default true).
  const [pinned, setPinnedState] = useState(true)
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

  const chip = STATE_CHIP[proxyState] ?? STATE_CHIP.stopped
  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background/95 text-foreground">
      <header className="app-drag flex shrink-0 items-center gap-1.5 border-b px-3 py-2.5">
        <Logo size={18} />
        <span className="min-w-0 flex-1 truncate font-serif text-[15px] font-normal tracking-tight">TeamClaude</span>
        <span
          className={`shrink-0 rounded-full border px-2 py-[3px] font-mono text-[9px] font-medium tracking-[0.12em] uppercase leading-none ${chip.className}`}
        >
          {compact ? chip.label : `proxy · ${chip.label}`}
        </span>
        <div className="app-no-drag flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground"
            aria-label={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
            title={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
            onClick={() => setTabsCollapsed(v => !v)}>
            {tabsCollapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground"
            aria-label="Minimize to taskbar"
            title="Minimize to taskbar" onClick={() => void window.tc.window.minimize()}>
            <Minus className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground"
            aria-label={compact ? 'Exit compact mode' : 'Compact HUD mode'}
            title={compact ? 'Exit compact mode' : 'Compact HUD mode'}
            onClick={toggleCompact}>
            {compact ? <Maximize2 className="size-4" /> : <Minimize2 className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon-sm"
            aria-label={pinned ? 'Stop keeping on top' : 'Keep on top'}
            title={pinned ? 'On top of other windows — click to stack normally' : 'Keep on top of other windows'}
            className={pinned ? 'text-primary hover:text-primary' : 'text-muted-foreground hover:text-foreground'}
            onClick={() => { const next = !pinned; setPinnedState(next); void window.tc.window.setPinned(next) }}>
            {pinned ? <Pin className="size-4" /> : <PinOff className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground"
            aria-label="Hide panel" onClick={() => void window.tc.window.hide()}>
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
              {NAV_TABS.map(t => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                  {/* The clay underline lives inside whichever trigger is
                      active; the shared layoutId makes it slide there. */}
                  {tab === t.value && (
                    <motion.span
                      layoutId="tc-active-tab"
                      className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary"
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                    />
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <TabsContent value="dashboard"><ViewFade><Dashboard compact={compact} /></ViewFade></TabsContent>
          <TabsContent value="accounts"><ViewFade><Accounts /></ViewFade></TabsContent>
          <TabsContent value="routing"><ViewFade><Routing /></ViewFade></TabsContent>
          <TabsContent value="activity"><ViewFade><Activity /></ViewFade></TabsContent>
          <TabsContent value="launcher"><ViewFade><Launcher /></ViewFade></TabsContent>
          <TabsContent value="settings"><ViewFade><Settings /></ViewFade></TabsContent>
        </div>
      </Tabs>
      )}
    </div>
  )
}
