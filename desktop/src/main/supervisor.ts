import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'

export type SupervisorState = 'stopped' | 'starting' | 'running' | 'attached' | 'crashed'

export interface SupervisorOptions {
  command: string
  args: string[]
  port: number
  apiKey: string
  /** Extra env for the spawned child (e.g. TEAMCLAUDE_CONFIG). Merged over process.env. */
  env?: NodeJS.ProcessEnv
  /**
   * Only attach to an already-running proxy if it's a compatible teamclaude
   * (answers /teamclaude/log). Prevents latching onto an older/foreign proxy
   * that happens to sit on our port. Default true.
   */
  requireCompatible?: boolean
  /**
   * How often (ms) to poll an externally-owned proxy we've attached to, so we
   * can take over if it dies. Default 4000. Kept small only in tests.
   */
  watchdogMs?: number
}

/**
 * Owns the teamclaude child process. If a proxy already answers on the port we
 * attach instead of spawning (dev convenience + single-proxy invariant). A
 * crashed child restarts with exponential backoff; stop() disarms everything.
 */
export class Supervisor extends EventEmitter {
  state: SupervisorState = 'stopped'
  child: ChildProcess | null = null
  lastLogLines: string[] = []
  private opts: SupervisorOptions
  private stopping = false
  private backoffMs = 1000
  private restartTimer: NodeJS.Timeout | null = null
  /** Poller that watches an attached (externally-owned) proxy; null unless attached. */
  private attachWatch: NodeJS.Timeout | null = null
  private watchdogMs: number

  constructor(opts: SupervisorOptions) {
    super()
    this.opts = opts
    this.watchdogMs = opts.watchdogMs ?? 4000
  }

  private setState(s: SupervisorState): void {
    this.state = s
    // The attached watchdog only makes sense while attached: tear it down on any
    // transition away, and (re)arm it on entry. Centralizing the lifecycle here
    // keeps it consistent across every recovery path.
    if (s !== 'attached' && this.attachWatch) {
      clearInterval(this.attachWatch)
      this.attachWatch = null
    }
    // A successful run or attach means the port is healthy again; reset the
    // restart backoff so the next failure starts from the short delay.
    if (s === 'running' || s === 'attached') this.backoffMs = 1000
    if (s === 'attached') this.startAttachWatch()
    this.emit('state', s)
  }

  /**
   * While attached to an externally-owned proxy, poll it. If it goes down the
   * port is (probably) free again, so route recovery through start() — which
   * spawns our own child on a free port, or re-attaches / retries if something
   * else has grabbed it. Cleared automatically on any transition out of
   * 'attached' (see setState) and in stop().
   */
  private startAttachWatch(): void {
    if (this.attachWatch) return
    const watch = setInterval(async () => {
      if (this.state !== 'attached' || this.attachWatch !== watch) return
      if (await this.isUp()) return
      if (this.attachWatch === watch) { clearInterval(watch); this.attachWatch = null }
      void this.start()
    }, this.watchdogMs)
    watch.unref?.()
    this.attachWatch = watch
  }

  async isUp(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.opts.port}/teamclaude/status`, {
        headers: { 'x-api-key': this.opts.apiKey },
        signal: AbortSignal.timeout(1500),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** True only if the proxy on our port is a compatible teamclaude (has /teamclaude/log). */
  async isCompatible(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.opts.port}/teamclaude/log`, {
        headers: { 'x-api-key': this.opts.apiKey },
        signal: AbortSignal.timeout(1500),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async start(): Promise<void> {
    this.stopping = false
    if (await this.isUp()) {
      const compatible = this.opts.requireCompatible === false || await this.isCompatible()
      if (compatible) { this.setState('attached'); return }
      // Something incompatible (e.g. an older proxy) holds our port. Don't
      // attach to it and don't fight it for the same port; surface 'crashed'.
      // But schedule a backoff retry through start() so that if that holder
      // later exits we reclaim the port instead of giving up permanently.
      this.setState('crashed')
      if (!this.stopping) {
        this.restartTimer = setTimeout(() => { void this.start() }, this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
      }
      return
    }
    this.spawnChild()
  }

  private spawnChild(): void {
    this.setState('starting')
    const useShell = process.platform === 'win32' // resolve teamclaude.cmd shims
    // Under a shell, spawn concatenates command+args without escaping, so a
    // token containing spaces (e.g. C:\Program Files\nodejs\node.exe) would be
    // split by the shell. Quote whitespace-bearing tokens; bare shims such as
    // `teamclaude.cmd` stay unquoted so PATHEXT resolution still works.
    const quote = (s: string): string => (useShell && /\s/.test(s) ? `"${s}"` : s)
    const child = spawn(quote(this.opts.command), this.opts.args.map(quote), {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
      env: { ...process.env, ...(this.opts.env ?? {}) },
    })
    this.child = child
    // On Windows the shell wraps the real process in cmd.exe; `child.kill()`
    // would terminate only that wrapper and orphan the node proxy (leaking the
    // port). Replace kill() with a tree-kill so both stop() and an external
    // kill of `child` take down the whole tree.
    if (useShell && child.pid != null) {
      const pid = child.pid
      child.kill = (): boolean => {
        try {
          const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          })
          // A spawn failure (e.g. taskkill missing) surfaces asynchronously as an
          // 'error' event. Without a listener Node re-throws it as an uncaught
          // exception and crashes the Electron main process; swallow it here.
          tk.on('error', () => {
            // taskkill unavailable/failed; nothing more we can do.
          })
        } catch {
          // taskkill unavailable; nothing more we can do.
        }
        return true
      }
    }
    const capture = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue
        this.lastLogLines.push(line)
        if (this.lastLogLines.length > 100) this.lastLogLines.shift()
        this.emit('log', line)
      }
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    // One child death must produce exactly one crash transition. An 'error'
    // (e.g. ENOENT for a missing binary on shell:false) can fire on its own or
    // alongside 'exit'; this guard collapses both into a single handling.
    let handled = false
    const onDeath = (): void => {
      if (handled || this.child !== child) return
      handled = true
      this.child = null
      if (this.stopping) { this.setState('stopped'); return }
      this.setState('crashed')
      // Route recovery through start() (not a blind re-spawn): it re-checks the
      // port, so if another compatible proxy has since claimed it we attach
      // instead of crash-looping on EADDRINUSE.
      this.restartTimer = setTimeout(() => { void this.start() }, this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
    }
    child.on('exit', onDeath)
    // Without an 'error' listener, a spawn failure (missing `teamclaude` binary
    // on mac/Linux) is rethrown by Node as an uncaught exception → main crash.
    // Surface it in the log and route it through the same crash/backoff path.
    child.on('error', (err: Error) => {
      const line = `teamclaude failed to start: ${err.message}`
      this.lastLogLines.push(line)
      if (this.lastLogLines.length > 100) this.lastLogLines.shift()
      this.emit('log', line)
      onDeath()
    })
    // Poll until the status endpoint answers, then we're running.
    const poll = setInterval(async () => {
      if (this.child !== child) { clearInterval(poll); return }
      if (await this.isUp()) {
        clearInterval(poll)
        this.setState('running') // resets backoff (see setState)
      }
    }, 500)
    poll.unref?.()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    if (this.attachWatch) { clearInterval(this.attachWatch); this.attachWatch = null }
    const child = this.child
    if (!child) { this.setState('stopped'); return }
    await new Promise<void>(resolve => {
      let hardKill: NodeJS.Timeout | null = null
      const done = (): void => {
        if (hardKill) { clearTimeout(hardKill); hardKill = null }
        resolve()
      }
      child.once('exit', done)
      // On non-Windows this is the native child.kill() → SIGTERM, letting the
      // child run its graceful-shutdown handler. On Windows child.kill() is
      // overridden with a `taskkill /T /F` force tree-kill, so the child is
      // terminated outright and does NOT run any signal handler.
      child.kill()
      hardKill = setTimeout(() => { child.kill('SIGKILL') }, 5000)
      hardKill.unref?.()
    })
    this.child = null
    this.setState('stopped')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }
}
