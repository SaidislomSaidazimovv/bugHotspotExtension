/**
 * Tornhill "indentation as complexity" proxy (RESEARCH.md §1).
 *
 * A language-agnostic, parser-free estimate of structural complexity: deeper and
 * more frequent indentation ≈ more nested control flow ≈ harder-to-reason code.
 * Cheap (single pass, no AST) and works for any text file.
 *
 * Pure module — NO `vscode` import (ADR-1). The result type is declared *here*
 * on purpose: `core/types.ts` is owned by the churn layer, so the complexity
 * dimension keeps its own contract local to this file.
 *
 * Phase 4 refinement (noted, not done in v1): skip string-literal / comment
 * lines so block comments and heredocs don't inflate the score. v1 stays
 * deliberately syntax-blind for language-agnosticism and speed.
 */

export interface ComplexityResult {
  /** Sum of per-line logical indent across all counted (non-blank) lines. */
  total: number;
  /** Mean indent per counted line (`total / lines`); 0 when there are no counted lines. */
  mean: number;
  /** Largest single-line logical indent. */
  max: number;
  /** Number of non-blank (counted) lines. */
  lines: number;
}

export interface ComplexityOptions {
  /** Number of spaces that make up one indent level. Default 4. */
  spacesPerIndent?: number;
}

const DEFAULT_SPACES_PER_INDENT = 4;

/**
 * Logical indent of a single line:
 *   floor(leadingSpaces / spacesPerIndent) + leadingTabs
 * counting only the leading whitespace run (stops at the first non-whitespace
 * character). A tab counts as one full indent level regardless of
 * `spacesPerIndent`. Returns -1 for blank / whitespace-only lines so the caller
 * can skip them.
 */
function lineIndent(line: string, spacesPerIndent: number): number {
  let spaces = 0;
  let tabs = 0;
  let i = 0;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') {
      spaces++;
    } else if (ch === '\t') {
      tabs++;
    } else {
      break;
    }
  }
  // Ran to end of line without hitting a non-whitespace char → blank line.
  if (i === line.length) {
    return -1;
  }
  return Math.floor(spaces / spacesPerIndent) + tabs;
}

/**
 * Compute the indentation-proxy complexity of a file's text content.
 * Pure function of its inputs. Blank / whitespace-only lines are not counted.
 */
export function computeComplexity(
  content: string,
  opts: ComplexityOptions = {},
): ComplexityResult {
  const spacesPerIndent =
    opts.spacesPerIndent && opts.spacesPerIndent > 0
      ? opts.spacesPerIndent
      : DEFAULT_SPACES_PER_INDENT;

  let total = 0;
  let max = 0;
  let lines = 0;

  // Split on \n; tolerate Windows CRLF by stripping a trailing \r.
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const indent = lineIndent(line, spacesPerIndent);
    if (indent < 0) {
      continue; // blank / whitespace-only — skipped
    }
    total += indent;
    lines++;
    if (indent > max) {
      max = indent;
    }
  }

  const mean = lines === 0 ? 0 : total / lines;
  return { total, mean, max, lines };
}
