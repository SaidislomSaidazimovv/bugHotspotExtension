import { describe, it, expect } from 'vitest';
import { computeComplexity } from '../../core/complexity';

describe('computeComplexity', () => {
  it('returns all zeros for an empty string', () => {
    expect(computeComplexity('')).toEqual({ total: 0, mean: 0, max: 0, lines: 0 });
  });

  it('treats flat (unindented) code as zero complexity', () => {
    const src = ['const a = 1;', 'const b = 2;', 'foo();'].join('\n');
    expect(computeComplexity(src)).toEqual({ total: 0, mean: 0, max: 0, lines: 3 });
  });

  it('sums logical indent across nested blocks (4 spaces = 1 level)', () => {
    const src = [
      'function f() {', //      indent 0
      '    if (x) {', //        indent 1
      '        return 1;', //   indent 2
      '    }', //               indent 1
      '}', //                   indent 0
    ].join('\n');
    // indents 0,1,2,1,0 → total 4, max 2, lines 5, mean 0.8
    expect(computeComplexity(src)).toEqual({ total: 4, mean: 0.8, max: 2, lines: 5 });
  });

  it('counts each leading tab as one indent level', () => {
    const src = ['a', '\tb', '\t\tc'].join('\n');
    // indents 0,1,2 → total 3, max 2, lines 3, mean 1
    expect(computeComplexity(src)).toEqual({ total: 3, mean: 1, max: 2, lines: 3 });
  });

  it('combines leading tabs and spaces: floor(spaces / spacesPerIndent) + tabs', () => {
    // 1 tab + 6 spaces, spacesPerIndent 4 → 1 + floor(6/4)=1 → 2
    const src = '\t      x';
    expect(computeComplexity(src)).toEqual({ total: 2, mean: 2, max: 2, lines: 1 });
  });

  it('floors partial space indents', () => {
    const src = '      x'; // 6 spaces → floor(6/4) = 1
    expect(computeComplexity(src)).toEqual({ total: 1, mean: 1, max: 1, lines: 1 });
  });

  it('skips blank and whitespace-only lines (they are not counted)', () => {
    const src = [
      'a', //          indent 0  (counted)
      '', //           blank     (skipped)
      '    ', //       spaces    (skipped)
      '    b', //      indent 1  (counted)
      '\t', //         tab only  (skipped)
    ].join('\n');
    // counted: 0, 1 → total 1, lines 2, max 1, mean 0.5
    expect(computeComplexity(src)).toEqual({ total: 1, mean: 0.5, max: 1, lines: 2 });
  });

  it('honors the spacesPerIndent override', () => {
    const src = '        deep'; // 8 leading spaces
    expect(computeComplexity(src, { spacesPerIndent: 2 })).toEqual({
      total: 4,
      mean: 4,
      max: 4,
      lines: 1,
    });
    expect(computeComplexity(src, { spacesPerIndent: 4 })).toEqual({
      total: 2,
      mean: 2,
      max: 2,
      lines: 1,
    });
  });

  it('falls back to the default (4) for a non-positive spacesPerIndent', () => {
    const src = '        deep'; // 8 spaces → default 4 → 2
    expect(computeComplexity(src, { spacesPerIndent: 0 })).toEqual({
      total: 2,
      mean: 2,
      max: 2,
      lines: 1,
    });
  });

  it('reports max independently of mean', () => {
    const src = [
      'a', //               indent 0
      '            deep', // 12 spaces → indent 3
      'b', //               indent 0
    ].join('\n');
    const r = computeComplexity(src);
    expect(r.max).toBe(3); // single deepest line
    expect(r.mean).toBe(1); // 3 / 3 counted lines
    expect(r.total).toBe(3);
    expect(r.lines).toBe(3);
  });

  it('tolerates CRLF line endings and trailing newline', () => {
    const src = 'a\r\n    b\r\n';
    // a(0), b(1), trailing blank skipped → total 1, lines 2, max 1, mean 0.5
    expect(computeComplexity(src)).toEqual({ total: 1, mean: 0.5, max: 1, lines: 2 });
  });
});
