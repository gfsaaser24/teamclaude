const WINDOW_MS = 60_000
const MAX_RECREATES = 3

/**
 * Backoff policy for auto-recreating a crashed window: true while fewer than
 * MAX_RECREATES timestamps in `recentMs` fall within the trailing WINDOW_MS
 * of `nowMs`. Pure — the caller owns the timestamp array and decides when to
 * push a new entry (only on an actual recreation, not on every check).
 */
export function shouldRecreate(recentMs: number[], nowMs: number): boolean {
  const recent = recentMs.filter(t => nowMs - t < WINDOW_MS)
  return recent.length < MAX_RECREATES
}
