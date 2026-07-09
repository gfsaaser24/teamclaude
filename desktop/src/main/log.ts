import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 1024 * 1024

let logPath: string | null = null

/**
 * Line-oriented on-disk log at <userData>/logs/desktop.log. The supervisor
 * keeps only a 100-line in-memory buffer, so without this file a crash loop
 * leaves no evidence once the app exits. Best-effort throughout: logging must
 * never take the app down.
 */
export function initFileLog(userDataDir: string): void {
  try {
    const dir = join(userDataDir, 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'desktop.log')
    try {
      if (statSync(file).size > MAX_BYTES) {
        const old = join(dir, 'desktop.old.log')
        // Windows rename fails onto an existing target — clear it first.
        try { rmSync(old, { force: true }) } catch { /* keep the oversized log */ }
        renameSync(file, old)
      }
    } catch { /* no log yet */ }
    logPath = file
  } catch {
    logPath = null
  }
}

export function logLine(source: string, line: string): void {
  if (!logPath) return
  try { appendFileSync(logPath, `${new Date().toISOString()} [${source}] ${line}\n`) } catch { /* best-effort */ }
}
