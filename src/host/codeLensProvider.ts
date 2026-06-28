import * as vscode from 'vscode';

import { computeCodeRisk, type CodeRiskSeverity } from '../core/codeRisk';

// Per-region risk CodeLens (S7-A1): renders an inline "⚠ Risk: <severity> · depth
// N · M lines" lens above each risky region surfaced by S6-B1's per-region core.
// This is the README roadmap item "Per-function risk via CodeLens". Read-only
// consumer of the FROZEN `computeCodeRisk` — ZERO core edits. Complements the
// gutter decorations (S6-B2): the lens names the risk where the cursor reads
// code, the gutter tints the lines. Gated by the shared `hotspot.codeRiskEnabled`
// master switch and `hotspot.codeRiskMinSeverity` (same as the decorations), plus
// its own `hotspot.codeLensEnabled` toggle.

/** Ordering for the `>= minSeverity` gate (mirrors codeRiskDecorations). */
const RANK: Record<CodeRiskSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function getEnabled(): boolean {
  return vscode.workspace.getConfiguration('hotspot').get<boolean>('codeLensEnabled', true);
}

/**
 * The shared code-risk master switch (`hotspot.codeRiskEnabled`, default true) —
 * the same gate the gutter/hover decorations honor. Turning it off suppresses ALL
 * code-risk surfaces, the lens included, so the two never disagree.
 */
function getCodeRiskEnabled(): boolean {
  return vscode.workspace.getConfiguration('hotspot').get<boolean>('codeRiskEnabled', true);
}

function getMinSeverity(): CodeRiskSeverity {
  const v = vscode.workspace
    .getConfiguration('hotspot')
    .get<string>('codeRiskMinSeverity', 'medium');
  return v in RANK ? (v as CodeRiskSeverity) : 'medium';
}

/**
 * Build the risk CodeLenses for a document (at or above `minSeverity`). Each lens
 * sits on the region's first line and is informational (no command). Exported for
 * tests. Returns `[]` for a flat file or when everything is below `minSeverity`.
 */
export function buildCodeLenses(
  document: vscode.TextDocument,
  minSeverity: CodeRiskSeverity = 'medium',
): vscode.CodeLens[] {
  const lenses: vscode.CodeLens[] = [];
  for (const region of computeCodeRisk(document.getText())) {
    if (RANK[region.severity] < RANK[minSeverity]) {
      continue;
    }
    const line = Math.min(region.startLine, Math.max(0, document.lineCount - 1));
    const range = new vscode.Range(line, 0, line, 0);
    const title = `⚠ Risk: ${region.severity} · depth ${region.maxDepth} · ${region.lineCount} lines`;
    // No command → an informational, non-clickable lens (the title IS the message).
    lenses.push(new vscode.CodeLens(range, { title, command: '' }));
  }
  return lenses;
}

class CodeRiskCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!getEnabled() || !getCodeRiskEnabled() || document.uri.scheme !== 'file') {
      return [];
    }
    return buildCodeLenses(document, getMinSeverity());
  }

  /** Ask VS Code to re-query lenses (after a relevant config change). */
  refresh(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/**
 * Register the per-region risk CodeLens provider over `file:` documents. Refreshes
 * when `hotspot.codeLensEnabled` / `hotspot.codeRiskEnabled` /
 * `hotspot.codeRiskMinSeverity` change.
 */
export function registerCodeLens(context: vscode.ExtensionContext): void {
  const provider = new CodeRiskCodeLensProvider();
  context.subscriptions.push(
    provider,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('hotspot.codeLensEnabled') ||
        e.affectsConfiguration('hotspot.codeRiskEnabled') ||
        e.affectsConfiguration('hotspot.codeRiskMinSeverity')
      ) {
        provider.refresh();
      }
    }),
  );
}
