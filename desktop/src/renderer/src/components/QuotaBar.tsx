import { Progress } from '@renderer/components/ui/progress'
import { resetLong, untilReset } from '@renderer/lib/reset'

// Renders a single quota meter from a utilization ratio (0..1, or null) and an
// optional epoch-ms reset timestamp. Matches the teamclaude CLI's Session /
// Weekly / per-model weekly meters.
export default function QuotaBar({ label, ratio, resetMs }: {
  label: string; ratio: number | null; resetMs?: number | null
}): React.JSX.Element {
  const pct = Math.round((ratio ?? 0) * 100)
  const future = resetMs != null && resetMs > Date.now()
  const resets = future ? untilReset(resetMs as number) : null
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate" title={label}>{label}</span>
        <span className="shrink-0" title={future ? resetLong(resetMs as number) : undefined}>
          {pct}%{resets ? ` · resets in ${resets}` : ''}
        </span>
      </div>
      {/* Meter colors are semantic — teal OK / amber ≥80% / red ≥98% — and must
          stay decoupled from --primary: clay is the app's identity color, never
          a meter state. The <80% teal is explicit (it matches RadialMeter's OK
          constant) rather than falling through to Progress's default fill,
          which is bg-primary and now renders clay. */}
      <Progress value={pct} className={pct >= 98 ? '[&>div]:bg-destructive' : pct >= 80 ? '[&>div]:bg-amber-500' : '[&>div]:bg-[oklch(0.74_0.13_182)]'} />
    </div>
  )
}
