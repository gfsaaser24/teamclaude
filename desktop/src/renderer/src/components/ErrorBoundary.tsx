import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  name: string
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * Catches render errors in the subtree so one broken component blanks a
 * compact fallback card instead of leaving the whole window dead/white. Used
 * around BOTH renderer roots (the 420px flyout and the 56px collapsed dock
 * strip) — the fallback has no fixed width, just padding, so it renders
 * sanely at either size.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // window.tc can be missing (e.g. preload failed to load) — an error
    // boundary must never itself throw while reporting an error.
    window.tc?.log?.('error-boundary', `[${this.props.name}] ${error.message}\n${info.componentStack ?? ''}`)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full w-full items-center justify-center overflow-hidden p-2">
        <div className="flex w-fit min-w-0 max-w-full flex-col items-center gap-1.5 rounded-lg border border-border bg-background/90 p-2 text-center">
          <p className="break-words text-[11px] font-semibold text-foreground">Something broke</p>
          <p className="max-w-full break-words font-mono text-[9px] leading-tight text-muted-foreground">
            {error.message}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="app-no-drag w-full truncate rounded-md bg-foreground/10 px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-foreground/20"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
