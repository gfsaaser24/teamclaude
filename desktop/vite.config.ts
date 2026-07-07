// NOTE: electron-vite uses electron.vite.config.ts, not this file.
// This stub exists only so tooling that expects a standard Vite project
// (e.g. the shadcn CLI framework detection) can resolve the renderer's
// path alias and Tailwind plugin. It is not used by the app build/dev.
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  }
})
