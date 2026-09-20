import { defineConfig } from 'vitest/config'

// The plugin repository is a sibling of the deepseek-harness checkout, not a
// workspace inside it, so a bare `vitest run` would otherwise inherit the
// harness root config and find none of these specs. This config pins the
// project to this repository's own tests and to Node (the host-side modules
// under test read real files).
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
