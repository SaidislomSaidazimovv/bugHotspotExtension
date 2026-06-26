import { defineConfig } from '@vscode/test-cli';

// Integration tests (Electron). Pure `core/` unit tests live in src/test/core
// and run via `npm run unit` (Vitest, no Electron).
//
// - `**` so nested suites under out/test (e.g. out/test/host) are discovered.
// - `workspaceFolder: '.'` opens this repo as the test workspace so the scan
//   service runs against real git history. NOTE: @vscode/test-electron breaks
//   on paths containing spaces, so run `npm test` from the no-space mirror
//   (F:\Projects\hotspot), not from "F:\Main and Private\Extension".
export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: '.',
});
