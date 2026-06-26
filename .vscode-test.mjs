import { defineConfig } from '@vscode/test-cli';

// Integration tests only (top-level files under out/test). Pure `core/` unit
// tests live in src/test/core and run via `npm run unit` (Vitest, no Electron).
export default defineConfig({
  files: 'out/test/*.test.js',
});
