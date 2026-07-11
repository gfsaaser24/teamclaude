import { useEffect, useState } from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { FolderOpen } from 'lucide-react'

// Clay — the app's identity accent, matching --primary. Hardcoded (not
// var(--primary)) because `alpha()` below string-manipulates it for alpha
// variants, which var() can't do inline.
const ACCENT = 'oklch(0.672 0.131 38.756)'
const alpha = (a: number): string => ACCENT.replace(')', ` / ${a})`)

// Step 3 — routing. Two ways to point `claude` at the pool: the auto-route
// toggle (a live Switch backed by proxy.setAutoRoute) or opening a project,
// which drops a `teamclaude run` task. Illustrated with a mini terminal +
// claude → proxy → accounts flow.
export default function Route({ stepLabel }: { stepLabel: string }): React.JSX.Element {
  const [auto, setAuto] = useState(false)

  useEffect(() => {
    void window.tc.proxy
      .getAutoRoute?.()
      .then((r: { enabled: boolean }) => setAuto(!!r?.enabled))
      .catch(() => {})
  }, [])

  const toggle = async (v: boolean): Promise<void> => {
    setAuto(v)
    try {
      await window.tc.proxy.setAutoRoute(v)
    } catch {
      /* revert on failure so the switch never lies about state */
      setAuto(!v)
    }
  }

  return (
    <div className="flex flex-col px-1 py-3">
      <p className="text-center font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-muted-foreground">
        {stepLabel}
      </p>
      <h1 className="mt-1 text-center font-serif text-2xl font-normal tracking-tight">
        Route your Claude through it.
      </h1>
      <p className="mx-auto mt-1.5 max-w-[36ch] text-balance text-center text-xs leading-relaxed text-muted-foreground">
        TeamClaude runs a local proxy. Send <span className="font-mono">claude</span> through it and
        every request draws from your pooled accounts.
      </p>

      <TerminalMock />

      {/* Way 1 — auto-route toggle */}
      <label className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-card/40 px-3 py-2.5">
        <span className="min-w-0">
          <span className="text-xs font-medium">Auto-route new terminals</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            Sets <span className="font-mono">ANTHROPIC_BASE_URL</span> so any new{' '}
            <span className="font-mono">claude</span> flows here automatically.
          </span>
        </span>
        <Switch checked={auto} onCheckedChange={(v) => void toggle(v)} />
      </label>

      {/* Way 2 — open a project */}
      <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-border/70 bg-card/40 px-3 py-2.5">
        <span
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: alpha(0.12), color: ACCENT }}
        >
          <FolderOpen className="size-3.5" />
        </span>
        <span className="min-w-0">
          <span className="text-xs font-medium">Or open a project</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            From the Projects tab — TeamClaude adds a <span className="font-mono">teamclaude run</span>{' '}
            task so the editor terminal starts already routed.
          </span>
        </span>
      </div>
    </div>
  )
}

// Mini terminal window: the command, then claude → proxy → 3 account dots.
function TerminalMock(): React.JSX.Element {
  return (
    <div className="mx-auto mt-3 w-full max-w-[280px] overflow-hidden rounded-lg border border-border/70 bg-[oklch(0.14_0.004_84.586)] shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-border/50 px-2.5 py-1.5">
        <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        <span className="ml-1 text-[9px] text-muted-foreground">teamclaude</span>
      </div>
      <div className="space-y-1.5 p-3 font-mono text-[11px] leading-tight">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">~/app</span>
          <span className="shrink-0" style={{ color: ACCENT }}>
            ❯
          </span>
          <span className="truncate">teamclaude run</span>
        </div>
        <div className="truncate text-[10px] text-muted-foreground">↳ routing through your pool…</div>

        {/* Flow: claude → proxy → accounts */}
        <div className="mt-2 flex items-center justify-center gap-1.5 pt-0.5 text-[10px]">
          <span className="rounded border border-border/70 bg-background/50 px-1.5 py-0.5">claude</span>
          <span className="text-muted-foreground">→</span>
          <span
            className="rounded px-1.5 py-0.5 font-medium"
            style={{ border: `1px solid ${alpha(0.5)}`, background: alpha(0.12), color: ACCENT }}
          >
            proxy
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="size-1.5 rounded-full"
                style={{ background: ACCENT, opacity: 1 - i * 0.28 }}
              />
            ))}
          </span>
        </div>
      </div>
    </div>
  )
}
