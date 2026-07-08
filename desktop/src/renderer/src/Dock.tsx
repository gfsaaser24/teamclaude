import { useEffect, useRef, useState } from 'react'
import { useTcStore } from './store'
import RadialMeter from './components/RadialMeter'
import type { TcAccountStatus, SupervisorState } from './types'

// ── Edge dock: a semi-transparent, always-on-top micro-HUD pinned to the right
// screen edge. COLLAPSED is a narrow vertical glass strip that's fully usable at
// a glance — a proxy "LIVE" bar, a per-request activity LED, and every account's
// quota rings stacked vertically. EXPANDED is the wider per-account panel with
// labels. The OS window resizes to match (window.tc.dock.setExpanded), so
// `expanded` here drives both what we render AND the physical window width.

const GAUGE = 30
const STROKE = 4

// Collapsed strip: a size-32 ring fits the 56px window with room for padding.
const RING = 32
const RING_STROKE = 3

/** Glass treatment for the proxy-live bar, keyed on supervisor state. All class
 *  strings are literal so Tailwind's JIT keeps them. */
function liveStyle(state: SupervisorState): { bar: string; text: string; label: string; pulse: boolean } {
  switch (state) {
    case 'running':
    case 'attached':
      return { bar: 'bg-emerald-500/25 ring-emerald-400/40', text: 'text-emerald-300', label: 'LIVE', pulse: false }
    case 'starting':
      return { bar: 'bg-amber-500/25 ring-amber-400/40', text: 'text-amber-200', label: '···', pulse: true }
    case 'crashed':
      return { bar: 'bg-red-500/25 ring-red-400/40', text: 'text-red-300', label: 'ERR', pulse: false }
    default: // stopped
      return { bar: 'bg-white/8 ring-white/15', text: 'text-muted-foreground', label: 'OFF', pulse: false }
  }
}

/** The Session / Weekly / Fable (+ optional Sonnet) rings for one account,
 *  stacked vertically for the collapsed strip. Sonnet only when present. */
function StackedRings({ q }: { q: TcAccountStatus['quota'] }): React.JSX.Element {
  return (
    <div
      className="flex flex-col items-center gap-1"
      title="Top→bottom: Session · Weekly · Fable"
    >
      <RadialMeter ratio={q.unified5h} resetMs={q.unified5hReset} size={RING} stroke={RING_STROKE} />
      <RadialMeter ratio={q.unified7d} resetMs={q.unified7dReset} size={RING} stroke={RING_STROKE} />
      <RadialMeter ratio={q.unified7dFable} resetMs={q.unified7dFableReset} size={RING} stroke={RING_STROKE} />
      {typeof q.unified7dSonnet === 'number' && (
        <RadialMeter ratio={q.unified7dSonnet} resetMs={q.unified7dSonnetReset} size={RING} stroke={RING_STROKE} />
      )}
    </div>
  )
}

/** The three (+ optional Sonnet) meters for one account, packed to fit 188px. */
function Meters({ q }: { q: TcAccountStatus['quota'] }): React.JSX.Element {
  const has = q.unified5h != null || q.unified7d != null || q.unified7dFable != null
  if (!has) {
    return <span className="text-[9px] leading-none text-muted-foreground/70">waiting…</span>
  }
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-1 gap-y-1">
      {typeof q.unified5h === 'number' && (
        <RadialMeter
          label="S"
          ratio={q.unified5h}
          resetMs={q.unified5hReset}
          size={GAUGE}
          stroke={STROKE}
        />
      )}
      {typeof q.unified7d === 'number' && (
        <RadialMeter
          label="W"
          ratio={q.unified7d}
          resetMs={q.unified7dReset}
          size={GAUGE}
          stroke={STROKE}
        />
      )}
      {typeof q.unified7dFable === 'number' && (
        <RadialMeter
          label="F"
          ratio={q.unified7dFable}
          resetMs={q.unified7dFableReset}
          size={GAUGE}
          stroke={STROKE}
        />
      )}
      {typeof q.unified7dSonnet === 'number' && (
        <RadialMeter
          label="So"
          ratio={q.unified7dSonnet}
          resetMs={q.unified7dSonnetReset}
          size={GAUGE}
          stroke={STROKE}
        />
      )}
    </div>
  )
}

export default function Dock(): React.JSX.Element {
  const { status, proxyState, events, init } = useTcStore()
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    void init()
  }, [init])

  // Activity LED: blink briefly each time a NEW request event lands. We track the
  // newest seen event id in a ref; when it advances and the newest event is a
  // request-* event, flash bright for ~90ms — one visible blink per request.
  const [flash, setFlash] = useState(false)
  const lastId = useRef(0)
  useEffect(() => {
    const newest = events[events.length - 1]
    if (!newest || newest.id <= lastId.current) return
    lastId.current = newest.id
    if (typeof newest.type === 'string' && newest.type.startsWith('request-')) {
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 90)
      return () => clearTimeout(t)
    }
    return
  }, [events])

  const accounts = status?.accounts ?? []
  const current = status?.currentAccount

  const toggle = (next: boolean): void => {
    setExpanded(next)
    void window.tc.dock.setExpanded(next) // resize the OS window to match
  }

  // ── Collapsed: a narrow vertical glass strip — chevron, proxy-live bar +
  //    activity LED, then each account's stacked quota rings (vertical scroll).
  if (!expanded) {
    const live = liveStyle(proxyState)
    return (
      <div className="flex h-screen w-screen items-stretch justify-end overflow-hidden bg-transparent">
        <div
          className="app-no-drag relative flex w-full flex-col overflow-hidden rounded-l-xl border border-r-0
                     border-white/12 bg-neutral-950/60 backdrop-blur-xl
                     shadow-[0_2px_20px_-4px_rgba(0,0,0,0.65)]"
        >
          {/* left accent hairline */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-3 left-0 w-px bg-gradient-to-b from-transparent via-primary/40 to-transparent"
          />

          {/* chevron — expands to the full per-account panel */}
          <button
            type="button"
            onClick={() => toggle(true)}
            aria-label="Expand dock"
            title={`Expand dock — ${accounts.length} account${accounts.length === 1 ? '' : 's'}`}
            className="group flex shrink-0 items-center justify-center py-1.5 text-foreground/60
                       transition-colors hover:text-foreground"
          >
            <span aria-hidden className="text-[13px] leading-none transition-transform group-hover:-translate-x-0.5">
              ‹
            </span>
          </button>

          {/* proxy-live bar + activity LED */}
          <div className="flex shrink-0 flex-col items-center gap-1 px-1.5 pb-1.5">
            <div
              title={`Proxy: ${proxyState}`}
              className={`flex w-full items-center justify-center rounded-md py-0.5 ring-1 ring-inset ${live.bar} ${live.pulse ? 'animate-pulse' : ''}`}
            >
              <span className={`text-[7px] font-bold uppercase leading-none tracking-[0.12em] ${live.text}`}>
                {live.label}
              </span>
            </div>
            <span
              aria-hidden
              title={flash ? 'Request activity' : 'Idle'}
              className={`size-1.5 rounded-full transition-all duration-150 ${
                flash
                  ? 'bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.75)]'
                  : 'bg-white/20'
              }`}
            />
          </div>

          {/* per-account stacked rings — scrolls vertically if there are many */}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden border-t border-white/8 px-1 py-1.5">
            {accounts.length === 0 ? (
              <p className="px-0.5 py-2 text-center text-[8px] leading-tight text-muted-foreground">
                no accts
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {accounts.map((a, i) => {
                  const active = a.name === current
                  return (
                    <div
                      key={a.name}
                      className={`flex flex-col items-center gap-1 rounded-lg px-1 py-1.5 ${
                        active ? 'bg-primary/10 ring-1 ring-inset ring-primary/30' : ''
                      }`}
                    >
                      <span
                        title={a.name}
                        className={`text-[10px] font-bold leading-none tabular-nums ${
                          active ? 'text-primary' : 'text-foreground/70'
                        }`}
                      >
                        #{i + 1}
                      </span>
                      <StackedRings q={a.quota} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Expanded: a translucent glass panel listing accounts as index + meters.
  return (
    <div className="flex h-screen w-screen items-stretch justify-end overflow-hidden bg-transparent">
      <div
        className="flex w-full flex-col overflow-hidden rounded-l-xl border border-r-0 border-white/12
                      bg-neutral-950/70 backdrop-blur-xl shadow-[0_2px_24px_-6px_rgba(0,0,0,0.7)]"
      >
        {/* header — collapse control + count */}
        <div className="flex shrink-0 items-center gap-1.5 border-b border-white/8 px-2 py-1.5">
          <button
            type="button"
            onClick={() => toggle(false)}
            aria-label="Collapse dock"
            title="Collapse dock"
            className="app-no-drag flex size-5 items-center justify-center rounded-md text-foreground/70
                       transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <span aria-hidden className="text-[13px] leading-none">
              ›
            </span>
          </button>
          <span className="min-w-0 flex-1 truncate text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            Dock
          </span>
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
            {accounts.length}
          </span>
        </div>

        {/* account list */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-1.5">
          {accounts.length === 0 ? (
            <p className="px-1 py-3 text-center text-[10px] text-muted-foreground">
              Waiting for accounts…
            </p>
          ) : (
            <ul className="space-y-1">
              {accounts.map((a, i) => {
                const active = a.name === current
                return (
                  <li
                    key={a.name}
                    title={a.name}
                    className={`flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors ${
                      active
                        ? 'bg-primary/12 ring-1 ring-inset ring-primary/35'
                        : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    {/* index number — the account's identity at a glance */}
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold tabular-nums ${
                        active
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'bg-white/8 text-foreground/75'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Meters q={a.quota} />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
