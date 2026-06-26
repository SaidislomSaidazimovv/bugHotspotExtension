import * as assert from 'assert';
import * as vscode from 'vscode';

import type { RiskResult } from '../../core/scorer';
import { buildMarkdownReport, buildJsonReport } from '../../host/exportReport';
import { trendBadge, confidenceNote } from '../../host/treeProvider';

// @vscode/test-cli (Electron) integration tests for the S7-A2 host surface:
// scoring settings, the export command, the trend badge, and the cold-start
// confidence note. The live config-change rescan + tree/status painting are
// confirmed via F5; here we assert the contributed manifest + the pure helpers.

/** Build a RiskResult with sensible defaults for the fields a test doesn't care about. */
function makeResult(over: Partial<RiskResult> & { path: string; score: number }): RiskResult {
  return {
    tier: 'low',
    trend: 'stable',
    signals: { freq: 1, churn: 1, recency: 0, authors: 1, ownership: 0, coupling: 0, complexity: 0 },
    ...over,
  } as RiskResult;
}

suite('S7-A2 scoring settings (manifest)', () => {
  let props: Record<string, any>;
  let commands: Array<{ command: string }>;

  suiteSetup(() => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot');
    assert.ok(ext, 'hotspot extension should be discoverable');
    props = ext!.packageJSON?.contributes?.configuration?.properties ?? {};
    commands = ext!.packageJSON?.contributes?.commands ?? [];
  });

  test('hotspot.weights keys match the scorer ScoreWeights exactly', () => {
    const weights = props['hotspot.weights'];
    assert.ok(weights, 'hotspot.weights contributed');
    assert.strictEqual(weights.type, 'object');
    const keys = Object.keys(weights.properties ?? {}).sort();
    assert.deepStrictEqual(
      keys,
      ['authors', 'churn', 'coupling', 'freq', 'ownership', 'recency'],
      'weight keys must be exactly the six ScoreWeights keys',
    );
    // Default vector sums to ~1.0 (matches scorer DEFAULT_WEIGHTS).
    const sum = Object.values(weights.default as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `default weights sum to 1 (got ${sum})`);
  });

  test('hotspot.thresholds + hotspot.sinceMonths are contributed', () => {
    const thresholds = props['hotspot.thresholds'];
    assert.ok(thresholds, 'hotspot.thresholds contributed');
    assert.deepStrictEqual(
      Object.keys(thresholds.properties ?? {}).sort(),
      ['critical', 'high', 'medium'],
      'threshold keys are medium/high/critical',
    );
    assert.deepStrictEqual(thresholds.default, { medium: 25, high: 50, critical: 75 });

    const since = props['hotspot.sinceMonths'];
    assert.ok(since, 'hotspot.sinceMonths contributed');
    assert.strictEqual(since.type, 'number');
    assert.strictEqual(since.default, 0, '0 = all history');
  });

  test('hotspot.exportReport command is contributed', () => {
    assert.ok(
      commands.some((c) => c.command === 'hotspot.exportReport'),
      'export command contributed',
    );
  });

  test('hotspot.exportReport command is registered at runtime', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('hotspot.exportReport'), 'export command registered');
  });
});

suite('S7-A2 export report (pure builders)', () => {
  const results = [
    makeResult({ path: 'src/a.ts', score: 80, tier: 'critical', trend: 'rising' }),
    makeResult({ path: 'src/b.ts', score: 10, tier: 'low', trend: 'cooling' }),
  ];

  test('Markdown report is a ranked table naming every file', () => {
    const md = buildMarkdownReport(results);
    assert.match(md, /# Hotspot Risk Report/);
    assert.match(md, /\| 1 \| src\/a\.ts \| 80 \| critical \|/);
    assert.match(md, /\| 2 \| src\/b\.ts \| 10 \| low \|/);
    assert.match(md, /rising/);
  });

  test('JSON report round-trips to the original results', () => {
    const parsed = JSON.parse(buildJsonReport(results)) as RiskResult[];
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].path, 'src/a.ts');
    assert.strictEqual(parsed[0].score, 80);
  });
});

suite('S7-A2 trend badge + confidence note (pure)', () => {
  test('trendBadge maps each trend to its arrow', () => {
    assert.strictEqual(trendBadge('rising'), '↑');
    assert.strictEqual(trendBadge('stable'), '→');
    assert.strictEqual(trendBadge('cooling'), '↓');
  });

  test('confidenceNote flags thin result sets', () => {
    // Empty → no note (the view-welcome covers "no scan yet").
    assert.strictEqual(confidenceNote([]), undefined);

    // Fewer than 5 scored files → low confidence even with a high top score.
    const few = [makeResult({ path: 'a', score: 90 })];
    assert.match(confidenceNote(few) ?? '', /Low confidence/);

    // Enough files but a near-zero top score → still low confidence.
    const flat = Array.from({ length: 6 }, (_, i) => makeResult({ path: `f${i}`, score: 3 }));
    assert.match(confidenceNote(flat) ?? '', /Low confidence/);

    // Enough files AND a meaningful top score → confident (no note).
    const healthy = Array.from({ length: 6 }, (_, i) =>
      makeResult({ path: `h${i}`, score: 60 - i }),
    );
    assert.strictEqual(confidenceNote(healthy), undefined);
  });
});
