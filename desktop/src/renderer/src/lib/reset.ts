// Reset-timestamp formatting shared by the quota meters. Weekly windows reset
// days out, so a bare time-of-day ("resets 16:00") is ambiguous — every format
// here carries the day, and the relative forms answer "how long until?".

const MIN_MS = 60_000

// Whole minutes until reset, floored at 1 so an imminent reset reads "1m".
function minutesUntil(resetMs: number, now: number): number {
  return Math.max(1, Math.ceil((resetMs - now) / MIN_MS))
}

/** Two-unit countdown: "2d 5h", "5h 12m", "12m". */
export function untilReset(resetMs: number, now: number = Date.now()): string {
  const total = minutesUntil(resetMs, now)
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** Single-unit countdown for tiny gauge captions: "2d", "5h", "12m". */
export function untilResetCompact(resetMs: number, now: number = Date.now()): string {
  const total = minutesUntil(resetMs, now)
  if (total >= 1440) return `${Math.round(total / 1440)}d`
  if (total >= 60) return `${Math.round(total / 60)}h`
  return `${total}m`
}

/** Absolute moment: "04:00 PM" if today, else "Tue, Jul 22, 04:00 PM". */
export function resetAt(resetMs: number, now: number = Date.now()): string {
  const t = new Date(resetMs)
  const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (new Date(now).toDateString() === t.toDateString()) return time
  return `${t.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`
}

/** Full tooltip clause: "resets in 2d 5h (Tue, Jul 22, 04:00 PM)". */
export function resetLong(resetMs: number, now: number = Date.now()): string {
  return `resets in ${untilReset(resetMs, now)} (${resetAt(resetMs, now)})`
}
