import { Progress } from '@renderer/components/ui/progress'

// Renders a single quota meter from a utilization ratio (0..1, or null) and an
// optional epoch-ms reset timestamp. Matches the teamclaude CLI's Session /
// Weekly / per-model weekly meters.
export default function QuotaBar({ label, ratio, resetMs }: {
  label: string; ratio: number | null; resetMs?: number | null
}): React.JSX.Element {
  const pct = Math.round((ratio ?? 0) * 100)
  const resets = resetMs != null && resetMs > Date.now()
    ? new Date(resetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate" title={label}>{label}</span>
        <span className="shrink-0">{pct}%{resets ? ` · resets ${resets}` : ''}</span>
      </div>
      <Progress value={pct} className={pct >= 98 ? '[&>div]:bg-destructive' : pct >= 80 ? '[&>div]:bg-amber-500' : ''} />
    </div>
  )
}
