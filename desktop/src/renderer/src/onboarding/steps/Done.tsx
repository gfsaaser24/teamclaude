import { Button } from '@renderer/components/ui/button'
import { Loader2, ArrowRight } from 'lucide-react'
import Logo from '@renderer/components/Logo'

// Clay — the app's identity accent, matching --primary.
const ACCENT = 'oklch(0.672 0.131 38.756)'

// Step 4 — the payoff. Owns its own primary CTA (the container hides its footer
// here) which persists onboarded + drops the user into the app.
export default function Done({
  onFinish,
  finishing = false,
  stepLabel,
}: {
  onFinish: () => void
  finishing?: boolean
  stepLabel: string
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-2 py-6 text-center">
      <div className="relative mb-5">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 rounded-full blur-2xl"
          style={{ background: `radial-gradient(circle, ${ACCENT} 0%, transparent 62%)`, opacity: 0.32 }}
        />
        <Logo size={104} animated />
      </div>

      <p className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-muted-foreground">
        {stepLabel}
      </p>
      <h1 className="mt-1 font-serif text-2xl font-normal tracking-tight">You&rsquo;re set.</h1>
      <p className="mt-2 max-w-[32ch] text-balance text-sm leading-relaxed text-muted-foreground">
        Your accounts are pooled and routing is live. Start a session — TeamClaude handles the
        hand-offs so you never watch a limit again.
      </p>

      <Button className="mt-6 w-full max-w-[220px]" onClick={onFinish} disabled={finishing}>
        {finishing ? (
          <>
            <Loader2 className="animate-spin" /> Entering…
          </>
        ) : (
          <>
            Enter TeamClaude <ArrowRight />
          </>
        )}
      </Button>
    </div>
  )
}
