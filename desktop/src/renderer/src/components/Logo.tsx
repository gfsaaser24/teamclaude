import { useId } from 'react'

// A self-contained, dependency-free animated mark built from concentric SVG
// rings that rotate at different speeds — echoing the app's radial-gauge motif.
// Motion is pure CSS `@keyframes` injected in a scoped <style> block; rotation
// is about the view-box centre (transform-box: view-box + transform-origin:
// center) so every ring and the orbiting dot pivot around (50,50). All motion
// pauses under `prefers-reduced-motion`, and `animated={false}` renders a crisp
// static version. No images, no libraries — crisp from 16px to 160px.

const TEAL = 'oklch(0.74 0.13 182)'
const TEAL_BRIGHT = 'oklch(0.84 0.13 182)'
const glow = (px: number, a: number): string => `drop-shadow(0 0 ${px}px oklch(0.74 0.13 182 / ${a}))`

export default function Logo({
  size = 64,
  animated = true,
}: {
  size?: number
  animated?: boolean
}): React.JSX.Element {
  // Unique, selector-safe ids so gradients from multiple mounted logos (header +
  // onboarding) never collide.
  const uid = `tclogo-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const arcId = `${uid}-arc`
  const coreId = `${uid}-core`
  const anim = (cls: string): string => (animated ? cls : '')

  return (
    <span
      className="inline-block shrink-0 align-middle"
      style={{ width: size, height: size, lineHeight: 0 }}
      aria-hidden="true"
    >
      {/* Keyframes + animation utilities are global-by-name and identical across
          instances, so re-injecting this block per logo is harmless. */}
      <style>{`
        .tclogo-ring { transform-box: view-box; transform-origin: center; }
        .tclogo-cw-slow { animation: tclogo-cw 18s linear infinite; }
        .tclogo-ccw-mid { animation: tclogo-ccw 11s linear infinite; }
        .tclogo-cw-fast { animation: tclogo-cw 7s linear infinite; }
        .tclogo-orbit   { animation: tclogo-cw 9s linear infinite; }
        .tclogo-pulse   { transform-box: view-box; transform-origin: center; animation: tclogo-pulse 3.4s ease-in-out infinite; }
        @keyframes tclogo-cw  { to { transform: rotate(360deg); } }
        @keyframes tclogo-ccw { to { transform: rotate(-360deg); } }
        @keyframes tclogo-pulse { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .tclogo-cw-slow, .tclogo-ccw-mid, .tclogo-cw-fast, .tclogo-orbit, .tclogo-pulse {
            animation: none !important;
          }
        }
      `}</style>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        role="img"
        aria-label="TeamClaude"
        style={{ display: 'block', overflow: 'visible' }}
      >
        <defs>
          <linearGradient id={arcId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={TEAL_BRIGHT} />
            <stop offset="100%" stopColor={TEAL} stopOpacity="0.12" />
          </linearGradient>
          <radialGradient id={coreId}>
            <stop offset="0%" stopColor={TEAL_BRIGHT} stopOpacity="0.9" />
            <stop offset="55%" stopColor={TEAL} stopOpacity="0.28" />
            <stop offset="100%" stopColor={TEAL} stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Faint full tracks the arcs ride on. */}
        <circle cx="50" cy="50" r="45" stroke={TEAL} strokeOpacity="0.1" strokeWidth="2.5" />
        <circle cx="50" cy="50" r="33" stroke={TEAL} strokeOpacity="0.08" strokeWidth="2.5" />

        {/* Outer arc — slow clockwise, fading gradient tail. pathLength=100 lets
            the dash array be read as a plain percentage of the ring. */}
        <circle
          className={`tclogo-ring ${anim('tclogo-cw-slow')}`}
          cx="50" cy="50" r="45" pathLength={100}
          stroke={`url(#${arcId})`} strokeWidth="3" strokeLinecap="round"
          strokeDasharray="42 100" style={{ filter: glow(2, 0.45) }}
        />

        {/* Mid arc — counter-clockwise. */}
        <circle
          className={`tclogo-ring ${anim('tclogo-ccw-mid')}`}
          cx="50" cy="50" r="33" pathLength={100}
          stroke={TEAL} strokeWidth="3.5" strokeLinecap="round"
          strokeDasharray="26 100" style={{ filter: glow(1.5, 0.4) }}
        />

        {/* Inner arc — fast clockwise. */}
        <circle
          className={`tclogo-ring ${anim('tclogo-cw-fast')}`}
          cx="50" cy="50" r="21" pathLength={100}
          stroke={TEAL_BRIGHT} strokeOpacity="0.85" strokeWidth="2.5"
          strokeLinecap="round" strokeDasharray="55 100"
        />

        {/* Orbiting dot skimming the outer ring. */}
        <g className={`tclogo-ring ${anim('tclogo-orbit')}`}>
          <circle cx="50" cy="5" r="3.2" fill={TEAL_BRIGHT} style={{ filter: glow(3, 0.8) }} />
        </g>

        {/* Breathing core. */}
        <circle className={anim('tclogo-pulse')} cx="50" cy="50" r="13" fill={`url(#${coreId})`} />
        <circle cx="50" cy="50" r="4.2" fill={TEAL_BRIGHT} style={{ filter: glow(3, 0.7) }} />
      </svg>
    </span>
  )
}
