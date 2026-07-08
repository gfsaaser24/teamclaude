import { Button } from '@renderer/components/ui/button'
import { Loader2, ArrowRight } from 'lucide-react'
import Logo from '@renderer/components/Logo'

const ACCENT = 'oklch(0.74 0.13 182)'

// Step 4 — the payoff. Owns its own primary CTA (the container hides its footer
// here) which persists onboarded + drops the user into the app.
export default function Done({
  onFinish,
  finishing = false,
}: {
  onFinish: () => void
  finishing?: boolean
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

      <h1 className="text-xl font-semibold tracking-tight">You&rsquo;re set.</h1>
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
