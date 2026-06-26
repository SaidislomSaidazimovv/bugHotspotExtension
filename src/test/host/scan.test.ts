import * as assert from 'assert';
import * as vscode from 'vscode';

import type { RiskResult } from '../../core/scorer';

// @vscode/test-cli (Electron) integration test. The test workspace is this repo
// (see .vscode-test.mjs `workspaceFolder: '.'`), so the scan runs against real
// git history.
suite('Hotspot scan service (integration)', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('hotspot-dev.hotspot');
    assert.ok(ext, 'extension should be discoverable by id');
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

  test('a second scan is idempotent in shape (cache reuse path)', async function () {
    this.timeout(60_000);
    const a = (await vscode.commands.executeCommand('hotspot.scan')) as RiskResult[];
    const b = (await vscode.commands.executeCommand('hotspot.scan')) as RiskResult[];
    assert.strictEqual(a.length, b.length, 'rescans should produce the same file count');
  });
});
