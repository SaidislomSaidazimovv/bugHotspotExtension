import * as assert from 'assert';
import * as vscode from 'vscode';

import { buildCodeLenses } from '../../host/codeLensProvider';

// @vscode/test-cli (Electron) integration test for the per-region risk CodeLens
// (S7-A1). Exercises the exported `buildCodeLenses` against a real TextDocument;
// the live provider wiring (registerCodeLens) is confirmed via F5.

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

suite('Code-risk CodeLens (integration)', () => {
  test('contributes the codeLensEnabled configuration', () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot');
    assert.ok(ext, 'hotspot extension should be discoverable');
    const props = ext!.packageJSON?.contributes?.configuration?.properties ?? {};
    assert.ok(props['hotspot.codeLensEnabled'], 'codeLensEnabled config contributed');
    assert.strictEqual(
      props['hotspot.codeLensEnabled'].default,
      true,
      'codeLensEnabled defaults ON',
    );
  });

  test('flat file yields no CodeLenses', async () => {
    const doc = await openDoc(FLAT);
    assert.strictEqual(buildCodeLenses(doc, 'low').length, 0, 'a flat file has no risky regions');
  });

  test('nested block produces a lens on the region start with a plain-language title', async () => {
    const doc = await openDoc(NESTED);
    const lenses = buildCodeLenses(doc, 'medium');
    assert.ok(lenses.length > 0, 'nested block should yield at least one lens');

    const lens = lenses[0];
    const title = lens.command?.title ?? '';
    assert.match(title, /Risk:/, 'lens names the risk');
    assert.match(title, /depth 6/, 'lens reports the max depth');
    assert.match(title, /lines/, 'lens reports the line count');
    // Lens sits on the region's first deep line (index 2), not the file top.
    assert.strictEqual(lens.range.start.line, 2, 'lens anchored to the region start');
  });

  test('minSeverity filters out lower-severity regions', async () => {
    const doc = await openDoc(NESTED);
    // The nested fixture scores in the medium band, so a `critical` floor hides it.
    assert.strictEqual(
      buildCodeLenses(doc, 'critical').length,
      0,
      'no region reaches critical → no lens',
    );
  });
});
