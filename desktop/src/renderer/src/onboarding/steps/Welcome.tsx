import Logo from '@renderer/components/Logo'

const ACCENT = 'oklch(0.74 0.13 182)'

// Step 1 — the hook. The animated ring/gauge mark is the illustration; the copy
// sells the one job TeamClaude does with a little attitude.
export default function Welcome(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center px-2 py-4 text-center">
      <div className="relative mt-2 mb-5">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 rounded-full blur-2xl"
          style={{ background: `radial-gradient(circle, ${ACCENT} 0%, transparent 62%)`, opacity: 0.3 }}
        />
        <Logo size={116} animated />
      </div>

      <h1 className="text-balance text-xl font-semibold tracking-tight">Never hit the wall again.</h1>
      <p className="mt-2 max-w-[34ch] text-balance text-sm leading-relaxed text-muted-foreground">
        TeamClaude pools your Claude accounts and quietly rotates to a fresh one the second a limit
        hits — so your session just keeps going. No cooldown staring contest, no juggling logins.
      </p>

      <div
        className="mt-4 flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium"
        style={{
          color: ACCENT,
          border: `1px solid ${ACCENT.replace(')', ' / 0.3)')}`,
          background: ACCENT.replace(')', ' / 0.07)'),
        }}
      >
        <span className="size-1.5 rounded-full" style={{ background: ACCENT }} />
        Set up in under a minute
      </div>
    </div>
  )
}
