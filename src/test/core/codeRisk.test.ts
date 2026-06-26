// Unit tests for the pure per-region code-risk core (S6-B1). No git, no vscode.
// Runner: Vitest (`npm run unit`). Fixtures are built with a 4-space `ind`
// helper so each level maps to exactly one logical indent depth (default
// spacesPerIndent = 4).

import { describe, it, expect } from 'vitest';

import { computeCodeRisk } from '../../core/codeRisk';

/** One source line at logical `depth` (4 spaces per level). */
function ind(depth: number, text: string): string {
  return '    '.repeat(depth) + text;
}

/** A deeply-nested (max depth 6), 30-line region embedded in a function. */
function deepLongFile(): string {
  const lines = [
    ind(0, 'function f() {'),
    ind(1, 'if (a) {'),
    ind(2, 'for (;;) {'),
    ind(3, 'while (b) {'), // depth 3 — region starts here (minDepth 3)
    ind(4, 'if (c) {'),
    ind(5, 'switch (d) {'),
  ];
  for (let k = 0; k < 24; k++) {
    lines.push(ind(6, `stmt${k}();`)); // 24 lines at depth 6
  }
  lines.push(ind(5, '}'));
  lines.push(ind(4, '}'));
  lines.push(ind(3, '}')); // last depth-3 line — region ends here
  lines.push(ind(2, '}')); // depth 2 < minDepth → closes the region
  lines.push(ind(1, '}'));
  lines.push(ind(0, '}'));
  return lines.join('\n');
}

describe('computeCodeRisk — basics', () => {
  it('returns [] for a flat / shallow file', () => {
    const flat = ['const a = 1;', 'function f() { return a; }', 'export default a;'].join('\n');
    expect(computeCodeRisk(flat)).toEqual([]);
  });

  it('returns [] for an empty string', () => {
    expect(computeCodeRisk('')).toEqual([]);
  });

  it('is deterministic (same input → identical output)', () => {
    const src = deepLongFile();
    expect(computeCodeRisk(src)).toEqual(computeCodeRisk(src));
  });
});

describe('computeCodeRisk — a deeply-nested long region', () => {
  const regions = computeCodeRisk(deepLongFile());

  it('finds exactly one region spanning the depth≥3 run', () => {
    expect(regions).toHaveLength(1);
    const r = regions[0];
    expect(r.startLine).toBe(3); // the `while (b) {` line
    expect(r.endLine).toBe(32); // the closing `}` at depth 3
    expect(r.maxDepth).toBe(6);
    expect(r.lineCount).toBe(30); // 32 - 3 + 1
  });

  it('scores it high with depth-weighted blend', () => {
    // depthFactor 6/10=0.6, lenFactor 30/60=0.5 → 100*(0.7*0.6 + 0.3*0.5) = 57.
    expect(regions[0].score).toBe(57);
    expect(regions[0].severity).toBe('high');
  });

  it('explains the risk in plain language', () => {
    expect(regions[0].reasons).toEqual([
      'deeply nested (depth 6)',
      'long block (30 lines)',
    ]);
  });
});

describe('computeCodeRisk — ranking & severity spread', () => {
  // A shallow 3-line depth-3 block (low) followed by the deep-long block (high).
  const shallow = [
    ind(0, 'function a() {'),
    ind(1, 'if (x) {'),
    ind(2, 'for (;;) {'),
    ind(3, 'doA1();'),
    ind(3, 'doA2();'),
    ind(3, 'doA3();'),
    ind(2, '}'),
    ind(1, '}'),
    ind(0, '}'),
  ].join('\n');
  const regions = computeCodeRisk(`${shallow}\n${deepLongFile()}`);

  it('returns both regions sorted by score descending', () => {
    expect(regions).toHaveLength(2);
    expect(regions[0].score).toBeGreaterThan(regions[1].score);
    expect(regions[0].severity).toBe('high'); // the deep-long block
    expect(regions[1].severity).toBe('low'); // the shallow 3-liner
  });

  it('labels a shallow region "nested" (not "deeply nested") with no long-block reason', () => {
    const low = regions[1];
    expect(low.maxDepth).toBe(3);
    expect(low.lineCount).toBe(3);
    expect(low.reasons).toEqual(['nested (depth 3)']);
  });
});

describe('computeCodeRisk — region boundaries', () => {
  it('drops regions shorter than minLines (default 3)', () => {
    const src = [
      ind(0, 'function g() {'),
      ind(1, 'if (x) {'),
      ind(2, 'for (;;) {'),
      ind(3, 'only();'), // a single depth-3 line
      ind(3, 'one();'), // two depth-3 lines total < minLines 3
      ind(2, '}'),
      ind(1, '}'),
      ind(0, '}'),
    ].join('\n');
    expect(computeCodeRisk(src)).toEqual([]);
  });

  it('absorbs a blank line inside a deep block (does not split the region)', () => {
    const src = [
      ind(0, 'function h() {'),
      ind(1, 'if (x) {'),
      ind(2, 'for (;;) {'),
      ind(3, 'a();'), // line 3
      '', // blank — must NOT end the region
      ind(3, 'b();'), // line 5
      ind(3, 'c();'), // line 6
      ind(2, '}'),
    ].join('\n');
    const regions = computeCodeRisk(src);
    expect(regions).toHaveLength(1);
    expect(regions[0].startLine).toBe(3);
    expect(regions[0].endLine).toBe(6); // trailing blank trimmed; inner blank kept in span
    expect(regions[0].lineCount).toBe(4);
  });

  it('splits into separate regions across a shallow line', () => {
    const block = (n: string) =>
      [
        ind(0, `function ${n}() {`),
        ind(1, 'if (x) {'),
        ind(2, 'for (;;) {'),
        ind(3, `${n}1();`),
        ind(3, `${n}2();`),
        ind(3, `${n}3();`),
        ind(2, '}'),
        ind(1, '}'),
        ind(0, '}'),
      ].join('\n');
    const regions = computeCodeRisk(`${block('p')}\n${block('q')}`);
    expect(regions).toHaveLength(2);
  });
});

describe('computeCodeRisk — options', () => {
  it('honors a raised minDepth', () => {
    // With minDepth 5, only the depth≥5 run counts (the switch + its body).
    const regions = computeCodeRisk(deepLongFile(), { minDepth: 5 });
    expect(regions).toHaveLength(1);
    expect(regions[0].startLine).toBe(5); // the `switch (d) {` line
    expect(regions[0].maxDepth).toBe(6);
    expect(regions[0].lineCount).toBe(26); // lines 5..30
  });

  it('respects spacesPerIndent so 2-space code still nests', () => {
    const twoSpace = [
      'function f() {',
      '  if (a) {',
      '    for (;;) {',
      '      deep1();', // 6 spaces → depth 3 at spacesPerIndent 2
      '      deep2();',
      '      deep3();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    // Default (4 spaces/level) sees max depth 1–2 → nothing qualifies.
    expect(computeCodeRisk(twoSpace)).toEqual([]);
    // At 2 spaces/level the inner block reaches depth 3 → one region.
    const regions = computeCodeRisk(twoSpace, { spacesPerIndent: 2 });
    expect(regions).toHaveLength(1);
    expect(regions[0].maxDepth).toBe(3);
  });

  it('handles CRLF line endings', () => {
    const crlf = deepLongFile().split('\n').join('\r\n');
    const regions = computeCodeRisk(crlf);
    expect(regions).toHaveLength(1);
    expect(regions[0].maxDepth).toBe(6);
    expect(regions[0].lineCount).toBe(30);
  });
});
