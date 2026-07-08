// A self-contained SVG donut gauge for the tray HUD. No chart library — the arc
// is a single stroked circle whose visible sweep is driven by stroke-dashoffset,
// so it stays crisp at 40px and animates smoothly when the ratio changes.
//
// Utilization colours match the CLI/QuotaBar thresholds: a confident teal until
// 80%, amber from 80%, destructive red from 98%. Colours are explicit oklch so
// the gauge reads the same on the app's hard-dark chrome regardless of --primary
// (which is near-white in dark mode).

const OK = 'oklch(0.74 0.13 182)' // teal — normal
const WARN = 'oklch(0.80 0.15 78)' // amber — ≥ 80%
const DANGER = 'oklch(0.645 0.22 25)' // red — ≥ 98%

function arcColor(ratio: number): string {
  if (ratio >= 0.98) return DANGER
  if (ratio >= 0.8) return WARN
  return OK
}

export default function RadialMeter({
  label,
  ratio,
  size = 46,
  stroke = 5,
  resetMs = null,
}: {
  label?: string
  ratio: number | null
  size?: number
  stroke?: number
  resetMs?: number | null
}): React.JSX.Element {
  const c = size / 2
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r

  const has = ratio != null
  const clamped = Math.min(1, Math.max(0, ratio ?? 0))
  const offset = circumference * (1 - clamped)
  const color = has ? arcColor(ratio ?? 0) : 'var(--muted-foreground)'

  const pct = Math.round((ratio ?? 0) * 100)
  const numberFont = Math.round(size * 0.3)
  const pctFont = Math.round(size * 0.17)
  const captionFont = Math.max(8, Math.round(size * 0.18))

  const resets =
    resetMs != null && resetMs > Date.now()
      ? new Date(resetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null

  const face = has ? `${pct}%` : '—'
  const aria = `${label ? `${label} ` : ''}${has ? `${pct}%` : 'no data'}`
  const title = `${label ? `${label} · ` : ''}${has ? `${pct}% used` : 'no data'}${resets ? ` · resets ${resets}` : ''}`

  return (
    <div
      className="flex shrink-0 flex-col items-center"
      style={{ width: size }}
      title={title}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={aria}
        shapeRendering="geometricPrecision"
        style={{ display: 'block' }}
      >
        {/* Track ring — faint at rest, fainter still when there's no data. */}
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke="var(--muted-foreground)"
          strokeOpacity={has ? 0.18 : 0.1}
          strokeWidth={stroke}
        />
        {/* Foreground arc — starts at 12 o'clock, sweeps clockwise by `ratio`. */}
        {has && (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${c} ${c})`}
            style={{
              transition:
                'stroke-dashoffset 620ms cubic-bezier(0.22,1,0.36,1), stroke 320ms ease',
              filter: `drop-shadow(0 0 ${stroke * 0.5}px ${color})`,
            }}
          />
        )}
        {/* Centred read-out: big number, small percent sign. */}
        <text
          x={c}
          y={c}
          textAnchor="middle"
          dominantBaseline="central"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {has ? (
            <>
              <tspan fontSize={numberFont} fontWeight={600} fill="var(--foreground)">
                {pct}
              </tspan>
              <tspan fontSize={pctFont} fontWeight={600} fill="var(--muted-foreground)" dx={1}>
                %
              </tspan>
            </>
          ) : (
            <tspan fontSize={numberFont} fontWeight={600} fill="var(--muted-foreground)">
              {face}
            </tspan>
          )}
        </text>
      </svg>
      {label && (
        <span
          className="mt-1 w-full truncate text-center leading-tight tracking-tight text-muted-foreground"
          style={{ fontSize: captionFont }}
        >
          {label}
        </span>
      )}
    </div>
  )
}
