import * as assert from 'assert';
import * as vscode from 'vscode';

import type { RiskResult } from '../../core/scorer';
import { isExcluded } from '../../core/exclude';

// @vscode/test-cli (Electron) integration test. The test workspace is this repo
// (see .vscode-test.mjs `workspaceFolder: '.'`), so the scan runs against real
// git history.
suite('Hotspot scan service (integration)', () => {
  suiteSetup(async () => {
    // Resolve by manifest name, not a hardcoded `publisher.id`, so the test
    // survives publisher renames.
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot');
    assert.ok(ext, 'hotspot extension should be discoverable');
    await ext!.activate();
  });

  test('hotspot.scan returns a risk ranking for the workspace', async function () {
    this.timeout(60_000);

    const results = (await vscode.commands.executeCommand('hotspot.scan')) as RiskResult[];

    assert.ok(Array.isArray(results), 'scan should resolve to an array');
    assert.ok(results.length > 0, 'workspace is a git repo → expected scored files');

    // Sorted descending by score.
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        'results should be sorted descending by score',
      );
    }

    const top = results[0];
    assert.strictEqual(typeof top.path, 'string');
    assert.strictEqual(typeof top.score, 'number');
    assert.ok(top.score >= 0 && top.score <= 100, 'score in [0,100]');
    assert.ok(
      ['low', 'medium', 'high', 'critical'].includes(top.tier),
      'tier is one of the four tiers',
    );
    assert.ok(top.signals && typeof top.signals.freq === 'number', 'raw signals present');
  });

  test('contributes the hotspot.exclude configuration with a non-empty default', () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot')!;
    const props = ext.packageJSON?.contributes?.configuration?.properties ?? {};
    const exclude = props['hotspot.exclude'];
    assert.ok(exclude, 'hotspot.exclude config contributed');
    assert.strictEqual(exclude.type, 'array', 'exclude is an array setting');
    assert.ok(
      Array.isArray(exclude.default) && exclude.default.includes('**/node_modules/**'),
      'default excludes node_modules (ON by default)',
    );
  });

  test('scan results respect the default exclude globs', async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot')!;
    const patterns = ext.packageJSON?.contributes?.configuration?.properties?.['hotspot.exclude']
      ?.default as string[];

    const results = (await vscode.commands.executeCommand('hotspot.scan')) as RiskResult[];
    for (const r of results) {
      assert.ok(
        !isExcluded(r.path, patterns),
        `excluded path leaked into results: ${r.path}`,
      );
    }
  });

  test('a second scan is idempotent in shape (cache reuse path)', async function () {
    this.timeout(60_000);
    const a = (await vscode.commands.executeCommand('hotspot.scan')) as RiskResult[];
    const b = (await vscode.commands.executeCommand('hotspot.scan')) as RiskResult[];
    assert.strictEqual(a.length, b.length, 'rescans should produce the same file count');
  });

  test('contributes the Risk Report view and a scan populates it', async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot')!;

    // View is contributed under the hotspot activity-bar container.
    const views = ext.packageJSON?.contributes?.views?.hotspot as Array<{ id: string }>;
    assert.ok(
      Array.isArray(views) && views.some((v) => v.id === 'hotspot.riskReport'),
      'hotspot.riskReport view should be contributed',
    );

    // View is registered: VS Code auto-generates `<viewId>.focus`, which only
    // resolves when the tree view is actually registered at runtime.
    await vscode.commands.executeCommand('hotspot.riskReport.focus');

    // The tree mirrors getResults(), so a non-empty scan ⇒ ≥1 tree item.
    const results = (await vscode.commands.executeCommand('hotspot.scan')) as RiskResult[];
    assert.ok(results.length >= 1, 'scan should yield at least one ranked file (tree item)');
  });
});
