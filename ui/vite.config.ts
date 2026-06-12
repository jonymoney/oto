import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// The MCP app UI must be a single self-contained HTML file: the host renders
// it in a sandboxed iframe whose CSP blocks external scripts/styles.
export default defineConfig({
  root: here,
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: resolve(here, '../dist/ui'),
    emptyOutDir: true,
  },
})
