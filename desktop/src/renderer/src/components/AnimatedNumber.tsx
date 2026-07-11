import { useEffect, useRef, useState } from 'react'
import { animate } from 'motion'

// A number read-out that ticks between successive values instead of snapping.
// The tween deliberately matches the RadialMeter arc (same ~0.6s duration and
// cubic-bezier), so digits and arc sweep move as one gesture. Tabular figures
// keep every digit the same width, so ticking never shifts the layout around
// it. Nothing animates on mount or on a loop — only on a changed `value`.
export default function AnimatedNumber({
  value,
  className,
}: {
  value: number
  className?: string
}): React.JSX.Element {
  const [display, setDisplay] = useState<number>(() => Math.round(value))
  // Live tween position — the departure point when `value` changes mid-flight,
  // so an interrupted tick continues from where it visibly is.
  const position = useRef(value)

  useEffect(() => {
    const from = position.current
    if (from === value) return undefined
    const controls = animate(from, value, {
      duration: 0.6,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => {
        position.current = v
        setDisplay(Math.round(v))
      },
    })
    return () => controls.stop()
  }, [value])

  return (
    <span className={className} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {display}
    </span>
  )
}
