import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { buildTreemapHtml, isSafeRepoRelPath } from '../../host/treemapView';

// Offline tripwire for the Risk Treemap webview (S9). The extension is "100%
// local / offline"; the treemap is the FIRST webview, the first place a remote
// origin / CDN / font could sneak in. These tests FAIL the build if that happens.

/** Patterns that betray a remote resource. The only allowed `http(s)` literal is
 *  the SVG XML namespace (a constant, not a network address) — whitelisted. */
const FORBIDDEN: RegExp[] = [
  /https?:\/\//i,
  /wss?:\/\//i, // websocket origin
  /cdn/i,
  /\/\/fonts/i,
  /unpkg/i,
  /jsdelivr/i,
  /googleapis/i,
  // protocol-relative remote origin in a URL context (quote/paren + //host.tld) —
  // tight enough not to false-positive on JS `//` line comments.
  /["'(]\/\/[a-z0-9][\w.\-]*\.[a-z]{2,}/i,
];
const SVG_NS_WHITELIST = 'http://www.w3.org/2000/svg';

function scrub(s: string): string {
  return s.split(SVG_NS_WHITELIST).join('');
}

function offenders(s: string): string[] {
  const t = scrub(s);
  return FORBIDDEN.filter((re) => re.test(t)).map((re) => re.source);
}

function hotspotExt(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot');
  assert.ok(ext, 'hotspot extension should be discoverable');
  return ext!;
}

function mediaFile(name: string): string {
  return fs.readFileSync(path.join(hotspotExt().extensionPath, 'media', name), 'utf8');
}

suite('S9 treemap — offline guarantee', () => {
  const html = buildTreemapHtml({
    cspSource: 'vscode-webview-stub',
    nonce: 'TESTNONCE0123456789',
    scriptUri: 'webview-resource-stub/treemap.js',
    styleUri: 'webview-resource-stub/treemap.css',
  });

  test('webview HTML pulls in no remote origin / CDN / font', () => {
    assert.deepStrictEqual(offenders(html), [], 'HTML must reference no remote resource');
  });

  test('media/treemap.js + media/treemap.css pull in no remote origin / CDN / font', () => {
    assert.deepStrictEqual(offenders(mediaFile('treemap.js')), [], 'treemap.js must be offline');
    assert.deepStrictEqual(offenders(mediaFile('treemap.css')), [], 'treemap.css must be offline');
  });

  test('HTML carries a strict CSP: default-src none + a per-load nonce', () => {
    assert.match(html, /default-src 'none'/, "CSP must start from default-src 'none'");
    assert.match(html, /nonce-TESTNONCE0123456789/, 'script must be gated by the nonce');
    // script-src must be nonce-ONLY: a regression to 'unsafe-inline'/'unsafe-eval'
    // keeps the nonce + carries no http, so the other checks would miss it.
    assert.match(html, /script-src 'nonce-[^']+';/, 'script-src is nonce-only');
    assert.ok(!/unsafe-inline/i.test(html), "no 'unsafe-inline'");
    assert.ok(!/unsafe-eval/i.test(html), "no 'unsafe-eval'");
    // No source directive may open a network channel.
    assert.ok(!/connect-src/i.test(html), 'no connect-src granted');
    assert.ok(!/img-src .*https?:/i.test(html), 'no remote img-src granted');
  });

  test('HTML wires the bundled script + style URIs (script tag carries the nonce)', () => {
    assert.match(
      html,
      /<link href="webview-resource-stub\/treemap\.css" rel="stylesheet"/,
      'style URI wired into <link>',
    );
    assert.match(
      html,
      /<script nonce="TESTNONCE0123456789" src="webview-resource-stub\/treemap\.js">/,
      'script URI + matching nonce wired into <script>',
    );
  });

  test('isSafeRepoRelPath rejects path-traversal / absolute paths (webview trust boundary)', () => {
    // Safe, in-repo relative paths.
    assert.ok(isSafeRepoRelPath('src/host/treemapView.ts'));
    assert.ok(isSafeRepoRelPath('README.md'));
    // Escapes — every one must be rejected so a crafted webview message can't
    // open a file outside the workspace.
    assert.ok(!isSafeRepoRelPath('../../../etc/passwd'), 'parent traversal');
    assert.ok(!isSafeRepoRelPath('src/../../secret'), 'embedded ..');
    assert.ok(!isSafeRepoRelPath('/etc/passwd'), 'posix-absolute');
    assert.ok(!isSafeRepoRelPath('C:\\Windows\\System32'), 'windows drive-absolute');
    assert.ok(!isSafeRepoRelPath('..'), 'bare ..');
    assert.ok(!isSafeRepoRelPath(''), 'empty');
    assert.ok(!isSafeRepoRelPath(undefined), 'non-string');
  });

  test('package.json declares NO runtime dependencies (locks zero-dep / offline)', () => {
    const raw = fs.readFileSync(path.join(hotspotExt().extensionPath, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    assert.ok(!('dependencies' in pkg), 'package.json must not have a runtime "dependencies" key');
  });

  test('the hotspot.showTreemap command is contributed and registered', async () => {
    const commands = hotspotExt().packageJSON?.contributes?.commands ?? [];
    assert.ok(
      commands.some((c: { command: string }) => c.command === 'hotspot.showTreemap'),
      'showTreemap command contributed',
    );
    await hotspotExt().activate();
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('hotspot.showTreemap'), 'showTreemap command registered at runtime');
  });
});
