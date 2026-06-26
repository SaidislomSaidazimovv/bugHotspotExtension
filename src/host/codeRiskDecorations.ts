import * as vscode from 'vscode';

import { computeCodeRisk, type CodeRiskSeverity } from '../core/codeRisk';

// In-editor code-risk decorations + hover (S6-B2): paints S6-B1's risky regions
// onto the open editor — a gutter mark + faint line tint per severity, plus a
// hover that explains the reason in plain language. Read-only consumer of the
// frozen `computeCodeRisk` (no core edits). Works for files of ANY tier: regions
// are scored within the file, so even a low-risk file can surface a risky block.

/** Severities high→low, for deterministic iteration. */
const SEVERITIES: CodeRiskSeverity[] = ['critical', 'high', 'medium', 'low'];

/** Ordering for the `>= minSeverity` gate. */
const RANK: Record<CodeRiskSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// Each severity reuses the `hotspot.tier*` palette (see package.json
// `contributes.colors`). The hex mirrors that palette so the gutter SVG + the
// faint background tint match the Explorer/panel colors; the overview-ruler mark
// uses the themable ThemeColor directly.
const SEV_STYLE: Record<CodeRiskSeverity, { colorId: string; hex: string }> = {
  critical: { colorId: 'hotspot.tierCritical', hex: '#e51400' },
  high: { colorId: 'hotspot.tierHigh', hex: '#f57c00' },
  medium: { colorId: 'hotspot.tierMedium', hex: '#d7a000' },
  low: { colorId: 'hotspot.tierMedium', hex: '#d7a000' },
};

/** Debounce window for re-decorating after a document edit. */
const REFRESH_DEBOUNCE_MS = 250;

function getEnabled(): boolean {
  return vscode.workspace.getConfiguration('hotspot').get<boolean>('codeRiskEnabled', true);
}

function getMinSeverity(): CodeRiskSeverity {
  const v = vscode.workspace
    .getConfiguration('hotspot')
    .get<string>('codeRiskMinSeverity', 'medium');
  return v in RANK ? (v as CodeRiskSeverity) : 'medium';
}

/** A small colored circle for the gutter, as an inline SVG data URI. */
function gutterIcon(hex: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4" fill="${hex}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

function wholeLineRange(document: vscode.TextDocument, startLine: number, endLine: number): vscode.Range {
  const end = Math.min(endLine, document.lineCount - 1);
  return new vscode.Range(startLine, 0, end, document.lineAt(end).text.length);
}

/**
 * Group a document's risky regions (at or above `minSeverity`) into per-severity
 * line ranges to decorate. Exported for tests.
 */
export function computeDecorationRanges(
  document: vscode.TextDocument,
  minSeverity: CodeRiskSeverity = 'medium',
): Map<CodeRiskSeverity, vscode.Range[]> {
  const out = new Map<CodeRiskSeverity, vscode.Range[]>();
  for (const region of computeCodeRisk(document.getText())) {
    if (RANK[region.severity] < RANK[minSeverity]) {
      continue;
    }
    const ranges = out.get(region.severity) ?? [];
    ranges.push(wholeLineRange(document, region.startLine, region.endLine));
    out.set(region.severity, ranges);
  }
  return out;
}

/**
 * Build the hover for a position inside a risky region (or `undefined` when the
 * position isn't in one at/above `minSeverity`). Exported for tests.
 */
export function buildCodeRiskHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  minSeverity: CodeRiskSeverity = 'medium',
): vscode.Hover | undefined {
  const hit = computeCodeRisk(document.getText()).find(
    (r) =>
      RANK[r.severity] >= RANK[minSeverity] &&
      position.line >= r.startLine &&
      position.line <= r.endLine,
  );
  if (!hit) {
    return undefined;
  }
  const md = new vscode.MarkdownString(
    `🔥 **Risky code (${hit.severity})** — ${hit.reasons.join(', ')}.\n\n` +
      `_Change this region carefully._`,
  );
  return new vscode.Hover(md, wholeLineRange(document, hit.startLine, hit.endLine));
}

/**
 * Register the code-risk decorations + hover. Refreshes on active-editor change
 * and (debounced) on document edits; respects `hotspot.codeRiskEnabled` and
 * `hotspot.codeRiskMinSeverity`.
 */
export function registerCodeRiskDecorations(context: vscode.ExtensionContext): void {
  const types = new Map<CodeRiskSeverity, vscode.TextEditorDecorationType>();
  for (const sev of SEVERITIES) {
    const { colorId, hex } = SEV_STYLE[sev];
    const type = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      // 8-digit hex = faint (~12%) tint of the tier color.
      backgroundColor: `${hex}1f`,
      overviewRulerColor: new vscode.ThemeColor(colorId),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      gutterIconPath: gutterIcon(hex),
      gutterIconSize: 'contain',
    });
    types.set(sev, type);
    context.subscriptions.push(type);
  }

  const refresh = (editor: vscode.TextEditor | undefined): void => {
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const ranges = getEnabled()
      ? computeDecorationRanges(editor.document, getMinSeverity())
      : new Map<CodeRiskSeverity, vscode.Range[]>();
    for (const sev of SEVERITIES) {
      editor.setDecorations(types.get(sev)!, ranges.get(sev) ?? []);
    }
  };

  const refreshAllVisible = (): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      refresh(editor);
    }
  };

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onEdit = (event: vscode.TextDocumentChangeEvent): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || event.document !== editor.document) {
      return;
    }
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => refresh(editor), REFRESH_DEBOUNCE_MS);
  };

  const hover: vscode.HoverProvider = {
    provideHover: (document, position) =>
      getEnabled() ? buildCodeRiskHover(document, position, getMinSeverity()) : undefined,
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidChangeTextDocument(onEdit),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hotspot.codeRiskEnabled') || e.affectsConfiguration('hotspot.codeRiskMinSeverity')) {
        refreshAllVisible();
      }
    }),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hover),
    { dispose: () => debounce && clearTimeout(debounce) },
  );

  refreshAllVisible(); // decorate whatever is already open on activation
}
