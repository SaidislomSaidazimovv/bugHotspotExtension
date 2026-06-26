import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  buildCodeRiskHover,
  computeDecorationRanges,
} from '../../host/codeRiskDecorations';

// @vscode/test-cli (Electron) integration test for the in-editor code-risk
// decorations + hover (S6-B2). Exercises the exported helpers against a real
// TextDocument; the actual setDecorations painting is visual-only (no API to
// read it back) and confirmed via F5.

/** Build a line indented `level` logical steps (4 spaces each). */
function indent(level: number, code: string): string {
  return ' '.repeat(level * 4) + code;
}

// A deeply-nested block: lines 2–6 sit at indent depth ≥ 3 (max depth 6).
const NESTED = [
  'function f() {', // 0
  indent(1, 'const a = 1;'), // 1 (depth 1 — shallow)
  indent(3, 'deep1();'), // 2 (depth 3)
  indent(5, 'deep2();'), // 3 (depth 5)
  indent(6, 'deep3();'), // 4 (depth 6 — max)
  indent(5, 'deep4();'), // 5 (depth 5)
  indent(4, 'deep5();'), // 6 (depth 4)
  '}', // 7
].join('\n');

const FLAT = ['const a = 1;', 'const b = 2;', 'foo(a, b);'].join('\n');

async function openDoc(content: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument({ content, language: 'javascript' });
}

suite('Code-risk decorations (integration)', () => {
  test('contributes the codeRisk configuration', () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot');
    assert.ok(ext, 'hotspot extension should be discoverable');
    const props = ext!.packageJSON?.contributes?.configuration?.properties ?? {};
    assert.ok(props['hotspot.codeRiskEnabled'], 'codeRiskEnabled config contributed');
    assert.ok(props['hotspot.codeRiskMinSeverity'], 'codeRiskMinSeverity config contributed');
  });

  test('flat file yields no decoration ranges', async () => {
    const doc = await openDoc(FLAT);
    const ranges = computeDecorationRanges(doc, 'low');
    const total = [...ranges.values()].reduce((n, r) => n + r.length, 0);
    assert.strictEqual(total, 0, 'a flat file has no risky regions');
  });

  test('nested block produces a decoration range covering the deep lines', async () => {
    const doc = await openDoc(NESTED);
    const ranges = computeDecorationRanges(doc, 'medium');

    const all = [...ranges.values()].flat();
    assert.ok(all.length > 0, 'nested block should yield at least one range');
    // The deepest line (index 4) must be inside a decorated range.
    assert.ok(
      all.some((r) => r.start.line <= 4 && r.end.line >= 4),
      'a range should cover the deepest line',
    );
  });

  test('minSeverity filters out lower-severity regions', async () => {
    const doc = await openDoc(NESTED);
    // The nested fixture scores in the medium band, so a `critical` floor hides it.
    const ranges = computeDecorationRanges(doc, 'critical');
    const total = [...ranges.values()].reduce((n, r) => n + r.length, 0);
    assert.strictEqual(total, 0, 'no region reaches critical → nothing to decorate');
  });

  test('hover inside a risky region explains it in plain language', async () => {
    const doc = await openDoc(NESTED);
    const hover = buildCodeRiskHover(doc, new vscode.Position(4, 8), 'medium');
    assert.ok(hover, 'hover should be present inside a risky region');
    const md = hover!.contents[0] as vscode.MarkdownString;
    assert.match(md.value, /Risky code/i, 'hover names the risk');
    assert.match(md.value, /deeply nested \(depth 6\)/, 'hover gives the plain-language reason');
  });

  test('hover is absent outside any risky region', async () => {
    const doc = await openDoc(NESTED);
    // Line 0 is the function signature at depth 0 — not a risky region.
    const hover = buildCodeRiskHover(doc, new vscode.Position(0, 2), 'medium');
    assert.strictEqual(hover, undefined, 'no hover outside a risky region');
  });
});
