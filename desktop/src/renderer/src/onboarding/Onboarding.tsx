import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTcStore } from '@renderer/store'
import Welcome from './steps/Welcome'
import Connect from './steps/Connect'
import Route from './steps/Route'
import Done from './steps/Done'

const TOTAL = 4

// First-run walkthrough. Owns the step index, the progress dots, and the
// Back/Next/Skip chrome; each step renders its own copy + code-drawn
// illustration. Finishing or skipping persists `onboarded: true` and calls
// onDone so App reveals the real UI. Connect's Next is gated on the live
// account count (read reactively from the store, refreshed on oauth-complete).
export default function Onboarding({ onDone }: { onDone: () => void }): React.JSX.Element {
  const config = useTcStore((s) => s.config) as { accounts?: unknown[] } | null
  const refreshConfig = useTcStore((s) => s.refreshConfig)
  const [step, setStep] = useState(0)
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    void refreshConfig()
  }, [refreshConfig])

  const accountCount = config?.accounts?.length ?? 0
  const isLast = step === TOTAL - 1
  const canNext = step === 1 ? accountCount >= 1 : true

  const finish = async (): Promise<void> => {
    setFinishing(true)
    try {
      await window.tc.settings.set({ onboarded: true })
    } catch {
      /* persistence is best-effort — never trap the user in onboarding */
    }
    onDone()
  }

  const back = (): void => setStep((s) => Math.max(0, s - 1))
  const next = (): void => setStep((s) => Math.min(TOTAL - 1, s + 1))

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Ambient teal wash bleeding down from the top edge. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-44"
        style={{
          background:
            'radial-gradient(70% 90% at 50% -10%, oklch(0.74 0.13 182 / 0.16), transparent 70%)',
        }}
      />

      {/* Progress dots + Skip */}
      <div className="relative flex shrink-0 items-center justify-between px-4 pt-3.5 pb-1.5">
        <div
          className="flex items-center gap-1.5"
          role="progressbar"
          aria-valuenow={step + 1}
          aria-valuemin={1}
          aria-valuemax={TOTAL}
          aria-label={`Step ${step + 1} of ${TOTAL}`}
        >
          {Array.from({ length: TOTAL }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === step
                  ? 'w-5'
                  : i < step
                    ? 'w-1.5 opacity-70'
                    : 'w-1.5 bg-muted-foreground/30'
              }`}
              style={i <= step ? { background: 'oklch(0.74 0.13 182)' } : undefined}
            />
          ))}
        </div>
        {!isLast && (
          <button
            onClick={() => void finish()}
            className="app-no-drag rounded px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip
          </button>
        )}
      </div>

      {/* Active step */}
      <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {step === 0 && <Welcome />}
        {step === 1 && <Connect accountCount={accountCount} />}
        {step === 2 && <Route />}
        {step === 3 && <Done onFinish={() => void finish()} finishing={finishing} />}
      </div>

      {/* Nav — Done owns its own primary CTA, so the footer hides on the last step. */}
      {!isLast && (
        <div className="relative flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-3">
          <Button variant="ghost" size="sm" disabled={step === 0} onClick={back}>
            <ChevronLeft /> Back
          </Button>
          <div className="flex-1" />
          {step === 1 && accountCount < 1 && (
            <span className="mr-1 text-[11px] text-muted-foreground">Connect one to continue</span>
          )}
          <Button size="sm" disabled={!canNext} onClick={next}>
            Next <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  )
}
