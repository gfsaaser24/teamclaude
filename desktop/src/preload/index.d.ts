import type { TcBridge } from './index'
declare global {
  interface Window { tc: TcBridge }
}
export {}
