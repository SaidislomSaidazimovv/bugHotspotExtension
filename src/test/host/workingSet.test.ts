import * as assert from 'assert';
import * as vscode from 'vscode';

import type { RiskResult } from '../../core/scorer';
import type { CoupledFile } from '../../core/coupling';
import {
  ALLOWED_GIT_SUBCOMMANDS,
  DisallowedGitCommandError,
  runGitReadOnly,
  getWorkingSetPaths,
  buildGitArgs,
  parseNameOnly,
} from '../../host/gitWorkingSet';
import {
  buildWorkingSetView,
  viewToPicks,
  DEFAULT_HINT_STRENGTH_FLOOR,
} from '../../host/workingSetLens';

// @vscode/test-cli (Electron) integration test for the Working-Set Risk Lens
// (S8-B). Covers (1) the locked, read-only git runner's whitelist, (2) the pure
// scoping/hint logic via a fake frozen service, and (3) the contributed config +
// command. The live status-bar/watcher wiring is confirmed via F5.

function repoRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, 'a workspace folder should be open for the integration tests');
  return root!;
}

/** Minimal RiskResult factory for the scoping tests. */
function riskResult(path: string, score: number): RiskResult {
  return {
    path,
    score,
    tier: score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low',
    signals: { freq: 0, churn: 0, recency: 0, authors: 0, ownership: 0, coupling: 0, complexity: 0 },
    trend: 'stable',
  };
}

/** A fake of the frozen HotspotService slice the lens consumes. */
function fakeService(
  byPath: Record<string, RiskResult>,
  coupled: Record<string, CoupledFile[]> = {},
) {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  return {
    getResults: () => Object.values(byPath),
    getResultForPath: (p: string) => byPath[norm(p)],
    getCoupledFiles: (p: string) => coupled[norm(p)] ?? [],
  };
}

suite('Working-Set Risk Lens — git runner (S8-B)', () => {
  test('rejects every subcommand outside the read-only whitelist (offline guarantee)', async () => {
    for (const bad of ['fetch', 'pull', 'push', 'remote', 'clone', 'log', 'status']) {
      await assert.rejects(
        runGitReadOnly(repoRoot(), [bad]),
        (err: unknown) => err instanceof DisallowedGitCommandError,
        `git '${bad}' must be rejected before spawning`,
      );
    }
  });

  test('rejects an empty / missing subcommand', async () => {
    await assert.rejects(runGitReadOnly(repoRoot(), []), DisallowedGitCommandError);
  });

  test('whitelist is exactly diff / merge-base / rev-parse', () => {
    assert.deepStrictEqual([...ALLOWED_GIT_SUBCOMMANDS].sort(), [
      'diff',
      'merge-base',
      'rev-parse',
    ]);
  });

  test('allows a whitelisted read-only command (rev-parse inside the work tree)', async () => {
    const res = await runGitReadOnly(repoRoot(), ['rev-parse', '--is-inside-work-tree']);
    assert.strictEqual(res.code, 0, 'rev-parse should succeed in the repo');
    assert.strictEqual(res.stdout, 'true');
  });

  test('buildGitArgs forces -c core.quotepath=false ahead of the subcommand', () => {
    const argv = buildGitArgs(['diff', 'HEAD', '--name-only']);
    assert.deepStrictEqual(argv.slice(0, 2), ['-c', 'core.quotepath=false']);
    assert.strictEqual(argv[2], 'diff', 'the subcommand stays right after the forced flag');
    assert.deepStrictEqual(argv, ['-c', 'core.quotepath=false', 'diff', 'HEAD', '--name-only']);
  });

  test('parseNameOnly normalizes to forward-slash repo-relative paths and drops blanks', () => {
    const parsed = parseNameOnly('src/a.ts\r\nsrc\\win\\b.ts\n\n./c.ts\n   \n');
    assert.deepStrictEqual(parsed, ['src/a.ts', 'src/win/b.ts', 'c.ts']);
  });

  test('allows merge-base (whitelisted) and resolves to a sha', async () => {
    const res = await runGitReadOnly(repoRoot(), ['merge-base', 'HEAD', 'HEAD']);
    assert.strictEqual(res.code, 0, 'merge-base HEAD HEAD should succeed');
    assert.match(res.stdout, /^[0-9a-f]{7,40}$/, 'resolves to a commit sha');
  });

  test('getWorkingSetPaths resolves to a (possibly empty) array of repo-relative paths', async function () {
    this.timeout(30_000);
    const paths = await getWorkingSetPaths(repoRoot());
    assert.ok(Array.isArray(paths), 'returns an array');
    for (const p of paths) {
      assert.ok(!p.includes('\\'), `path is forward-slash normalized: ${p}`);
    }
  });

  test('getWorkingSetPaths with an unresolvable baseRef falls back without throwing', async function () {
    this.timeout(30_000);
    const paths = await getWorkingSetPaths(repoRoot(), { baseRef: 'no-such-ref-xyz' });
    assert.ok(Array.isArray(paths), 'falls back to the HEAD diff (or empty), never throws');
    for (const p of paths) {
      assert.ok(!p.includes('\\'), `forward-slash normalized: ${p}`);
    }
  });
});

suite('Working-Set Risk Lens — scoping & hints (S8-B)', () => {
  test('scopes scored files to the working set, sorted desc by score', () => {
    const svc = fakeService({
      'src/a.ts': riskResult('src/a.ts', 80),
      'src/b.ts': riskResult('src/b.ts', 30),
      'src/c.ts': riskResult('src/c.ts', 99), // not in the working set
    });
    const view = buildWorkingSetView(svc, ['src/b.ts', 'src/a.ts']);
    assert.deepStrictEqual(
      view.scored.map((s) => s.path),
      ['src/a.ts', 'src/b.ts'],
      'only working-set files, highest risk first',
    );
    assert.strictEqual(view.noHistory.length, 0);
  });

  test('new / untracked files become "no history", never a fabricated score', () => {
    const svc = fakeService({ 'src/a.ts': riskResult('src/a.ts', 50) });
    const view = buildWorkingSetView(svc, ['src/a.ts', 'src/brand-new.ts']);
    assert.deepStrictEqual(view.scored.map((s) => s.path), ['src/a.ts']);
    assert.deepStrictEqual(view.noHistory, ['src/brand-new.ts']);
  });

  test('coupling-miss hint fires for a strong partner NOT in the working set', () => {
    const svc = fakeService(
      { 'src/a.ts': riskResult('src/a.ts', 60) },
      { 'src/a.ts': [{ path: 'src/partner.ts', strength: 0.8, sharedCommits: 12 }] },
    );
    const view = buildWorkingSetView(svc, ['src/a.ts']);
    assert.strictEqual(view.hints.length, 1);
    assert.strictEqual(view.hints[0].partner, 'src/partner.ts');
    assert.strictEqual(view.hints[0].changed, 'src/a.ts');
  });

  test('no hint when the strong partner is already in the working set (case-insensitive)', () => {
    const svc = fakeService(
      { 'src/a.ts': riskResult('src/a.ts', 60) },
      { 'src/a.ts': [{ path: 'src/Partner.ts', strength: 0.8, sharedCommits: 12 }] },
    );
    // Partner present with different casing — Windows owner: must still match.
    const view = buildWorkingSetView(svc, ['src/a.ts', 'src/partner.ts']);
    assert.strictEqual(view.hints.length, 0, 'partner in working set → no hint');
  });

  test('weak partners below the strength floor stay silent (young/ride-along files)', () => {
    const svc = fakeService(
      { 'src/a.ts': riskResult('src/a.ts', 60) },
      {
        'src/a.ts': [
          { path: 'src/weak.ts', strength: DEFAULT_HINT_STRENGTH_FLOOR - 0.01, sharedCommits: 6 },
        ],
      },
    );
    const view = buildWorkingSetView(svc, ['src/a.ts']);
    assert.strictEqual(view.hints.length, 0, 'below floor → silence, never a fabricated nudge');
  });

  test('files with no coupling data produce no hints (silence, not a guess)', () => {
    const svc = fakeService({ 'src/a.ts': riskResult('src/a.ts', 60) });
    const view = buildWorkingSetView(svc, ['src/a.ts']);
    assert.strictEqual(view.hints.length, 0);
  });

  test('viewToPicks copy keeps the "relative to this repo" framing', () => {
    const svc = fakeService({ 'src/a.ts': riskResult('src/a.ts', 60) });
    const picks = viewToPicks(buildWorkingSetView(svc, ['src/a.ts']));
    const scoredRow = picks.find((p) => p.label.includes('src/a.ts'));
    assert.ok(scoredRow, 'a scored row is rendered');
    assert.match(String(scoredRow!.description), /relative to this repo/i);
  });
});

suite('Working-Set Risk Lens — manifest (S8-B)', () => {
  test('contributes hotspot.workingSet.enabled defaulting OFF', () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot');
    assert.ok(ext, 'hotspot extension should be discoverable');
    const props = ext!.packageJSON?.contributes?.configuration?.properties ?? {};
    const cfg = props['hotspot.workingSet.enabled'];
    assert.ok(cfg, 'hotspot.workingSet.enabled config contributed');
    assert.strictEqual(cfg.type, 'boolean');
    assert.strictEqual(cfg.default, false, 'defaults OFF (opt-in, no-regression)');
  });

  test('contributes the hotspot.showWorkingSet command', () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot')!;
    const cmds = (ext.packageJSON?.contributes?.commands ?? []) as Array<{ command: string }>;
    assert.ok(
      cmds.some((c) => c.command === 'hotspot.showWorkingSet'),
      'hotspot.showWorkingSet command contributed',
    );
  });
});
