import { useMemo, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Loader2, LogIn, Check, TriangleAlert, Lock } from 'lucide-react'
import { useTcStore } from '@renderer/store'
import type { TcEvent } from '@renderer/types'

// Clay — the app's identity accent, matching --primary. Hardcoded (not
// var(--primary)) because `alpha()` below string-manipulates it for alpha
// variants, which var() can't do inline.
const ACCENT = 'oklch(0.672 0.131 38.756)'
const alpha = (a: number): string => ACCENT.replace(')', ` / ${a})`)

type Phase = 'idle' | 'starting' | 'browser' | 'complete' | 'error'

// Step 2 — the real Claude Code OAuth login. Kicks off window.tc.api.oauthLogin()
// and reflects the proxy's live oauth-* event stream (start → url → complete /
// error). Only events emitted AFTER the button click count, so a replayed
// oauth-complete from a prior session can't fake success. The account count is
// read reactively from the store; the container unlocks Next at >= 1.
export default function Connect({
  accountCount,
  stepLabel,
}: {
  accountCount: number
  stepLabel: string
}): React.JSX.Element {
  const events = useTcStore((s) => s.events)
  const [startId, setStartId] = useState<number | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  // Latest oauth-* event since the login was kicked off.
  const flow = useMemo<TcEvent | null>(() => {
    if (startId == null) return null
    const oe = events.filter((e) => e.type.startsWith('oauth-') && e.id > startId)
    return oe.length ? oe[oe.length - 1] : null
  }, [events, startId])

  const phase: Phase = localError
    ? 'error'
    : !flow
      ? startId == null
        ? 'idle'
        : 'starting'
      : flow.type === 'oauth-error'
        ? 'error'
        : flow.type === 'oauth-complete'
          ? 'complete'
          : flow.type === 'oauth-url'
            ? 'browser'
            : 'starting'

  const busy = phase === 'starting' || phase === 'browser'
  const errorText =
    localError ?? (flow?.type === 'oauth-error' ? String(flow.error ?? 'Login failed.') : null)

  const login = async (): Promise<void> => {
    setLocalError(null)
    const maxId = events.reduce((m, e) => Math.max(m, e.id), 0)
    setStartId(maxId)
    const r = await window.tc.api.oauthLogin()
    if (!r?.ok) setLocalError(r?.error ?? 'Could not start login. Is the proxy running?')
  }

  return (
    <div className="flex flex-col items-center px-1 py-3 text-center">
      <p className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-muted-foreground">
        {stepLabel}
      </p>
      <h1 className="mt-1 font-serif text-2xl font-normal tracking-tight">Connect an account.</h1>
      <p className="mt-1.5 max-w-[34ch] text-balance text-xs leading-relaxed text-muted-foreground">
        Sign in with your real Claude account. Add as many as you like — TeamClaude rotates between
        them. This runs the same login you already trust.
      </p>

      <BrowserMock />

      <Button className="mt-4 w-full max-w-[240px]" onClick={() => void login()} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
        {phase === 'complete' || accountCount > 0 ? 'Connect another account' : 'Connect an account'}
      </Button>

      <StatusLine phase={phase} flow={flow} errorText={errorText} />

      <div
        className="mt-4 flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px]"
        style={
          accountCount > 0
            ? { color: ACCENT, border: `1px solid ${alpha(0.3)}`, background: alpha(0.07) }
            : { border: '1px solid var(--border)' }
        }
      >
        {accountCount > 0 ? (
          <Check className="size-3.5 shrink-0" />
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
        )}
        <span className={accountCount > 0 ? '' : 'text-muted-foreground'}>
          {accountCount === 0
            ? 'No accounts connected yet'
            : `${accountCount} account${accountCount === 1 ? '' : 's'} connected — Next is unlocked`}
        </span>
      </div>
    </div>
  )
}

// A tiny on-theme browser window standing in for the login page you'll see.
function BrowserMock(): React.JSX.Element {
  return (
    <div className="mt-4 w-full max-w-[264px] overflow-hidden rounded-lg border border-border/70 bg-card/50 shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/30 px-2.5 py-1.5">
        <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        <div className="ml-1.5 flex min-w-0 flex-1 items-center gap-1 rounded bg-background/60 px-2 py-0.5">
          <Lock className="size-2.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-[9px] text-muted-foreground">claude.ai/oauth/authorize</span>
        </div>
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <span className="size-4 shrink-0 rounded-full" style={{ background: alpha(0.9) }} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="h-1.5 w-2/3 rounded bg-muted-foreground/25" />
            <div className="h-1.5 w-2/5 rounded bg-muted-foreground/15" />
          </div>
        </div>
        <div
          className="mt-1 flex items-center justify-center rounded-md py-1.5 text-[10px] font-semibold"
          style={{ background: ACCENT, color: 'oklch(0.191 0.002 106.586)' /* --primary-foreground, #141413 */ }}
        >
          Authorize TeamClaude
        </div>
      </div>
    </div>
  )
}

function StatusLine({
  phase,
  flow,
  errorText,
}: {
  phase: Phase
  flow: TcEvent | null
  errorText: string | null
}): React.JSX.Element | null {
  if (phase === 'idle') return null

  if (phase === 'error') {
    return (
      <p className="mt-2.5 flex items-center justify-center gap-1.5 text-[11px] text-destructive">
        <TriangleAlert className="size-3.5 shrink-0" />
        <span className="max-w-[32ch] truncate" title={errorText ?? undefined}>
          {errorText}
        </span>
      </p>
    )
  }
  if (phase === 'complete') {
    const acct = flow?.account ? String(flow.account) : null
    return (
      <p className="mt-2.5 flex items-center justify-center gap-1.5 text-[11px]" style={{ color: ACCENT }}>
        <Check className="size-3.5 shrink-0" />
        <span className="max-w-[32ch] truncate">Connected{acct ? ` ${acct}` : ''}!</span>
      </p>
    )
  }
  return (
    <p className="mt-2.5 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      {phase === 'browser' ? 'Complete the login in your browser…' : 'Starting login…'}
    </p>
  )
}
