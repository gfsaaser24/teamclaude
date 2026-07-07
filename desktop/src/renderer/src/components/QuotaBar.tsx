import { Progress } from '@renderer/components/ui/progress'

// quota entries look like { utilization: 0..1, resetsAt: ISO } per bucket
export default function QuotaBar({ label, utilization, resetsAt }: {
  label: string; utilization: number | undefined; resetsAt?: string
}): React.JSX.Element {
  const pct = Math.round((utilization ?? 0) * 100)
  const resets = resetsAt ? new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{pct}%{resets ? ` · resets ${resets}` : ''}</span>
      </div>
      <Progress value={pct} className={pct >= 98 ? '[&>div]:bg-destructive' : pct >= 80 ? '[&>div]:bg-amber-500' : ''} />
    </div>
  )
}
