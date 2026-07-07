import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'

export type SupervisorState = 'stopped' | 'starting' | 'running' | 'attached' | 'crashed'

export interface SupervisorOptions {
  command: string
  args: string[]
  port: number
  apiKey: string
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

  constructor(opts: SupervisorOptions) {
    super()
    this.opts = opts
  }

  private setState(s: SupervisorState): void {
    this.state = s
    this.emit('state', s)
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

  async start(): Promise<void> {
    this.stopping = false
    if (await this.isUp()) {
      this.setState('attached')
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
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
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
    child.on('exit', () => {
      this.child = null
      if (this.stopping) { this.setState('stopped'); return }
      this.setState('crashed')
      this.restartTimer = setTimeout(() => this.spawnChild(), this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
    })
    // Poll until the status endpoint answers, then we're running.
    const poll = setInterval(async () => {
      if (this.child !== child) { clearInterval(poll); return }
      if (await this.isUp()) {
        clearInterval(poll)
        this.backoffMs = 1000
        this.setState('running')
      }
    }, 500)
    poll.unref?.()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const child = this.child
    if (!child) { this.setState('stopped'); return }
    await new Promise<void>(resolve => {
      let hardKill: NodeJS.Timeout | null = null
      const done = (): void => {
        if (hardKill) { clearTimeout(hardKill); hardKill = null }
        resolve()
      }
      child.once('exit', done)
      child.kill()                                     // SIGTERM / tree-kill → graceful shutdown
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
