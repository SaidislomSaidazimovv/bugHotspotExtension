import * as vscode from 'vscode';

import type { HotspotService } from './scanService';
import type { RiskResult } from '../core/scorer';
import {
  buildExplanations,
  effectiveWeights,
  SIGNAL_LABEL,
  type ExplanationView,
} from '../core/explain';

// Export Risk Report (S7-A2): dump the current ranking as Markdown or JSON into a
// new untitled editor (non-destructive — the user saves where they like). Lets a
// scan leave the editor: paste into a PR, a ticket, or a code-review checklist.
//
// Risk Explainability (S8-A): when explanations are supplied (and gated on
// `hotspot.explainEnabled` at the call site), Markdown gains a "Why" column with
// the dominant driver + its % share and JSON gains a per-file `explanation`
// object. With no explanations the output is byte-identical to v0.0.4.

/** Compact "dominant driver + its share" for a Markdown table cell (or "—"). */
function whyCell(view: ExplanationView): string {
  if (view.dominant === null) {
    return '—';
  }
  return `${SIGNAL_LABEL[view.dominant]} ${Math.round(view.shares[view.dominant] * 100)}%`;
}

const TREND_LABEL: Record<RiskResult['trend'], string> = {
  rising: '↑ rising',
  stable: '→ stable',
  cooling: '↓ cooling',
};

/** Escape a free-form value for a Markdown table cell — a literal `|` would
 *  otherwise split the row and corrupt every column after it. Paths are the only
 *  user-controlled cell (a filename may contain `|` on Linux/macOS). */
function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/**
 * Markdown report: a ranked table + a one-line framing note. Pure; exported for
 * tests. When `explanations` is supplied a trailing "Why" column names each file's
 * dominant risk driver + its % share; omit it for the v0.0.4-identical table.
 */
export function buildMarkdownReport(
  results: readonly RiskResult[],
  explanations?: ReadonlyMap<string, ExplanationView>,
): string {
  const why = explanations !== undefined;
  const lines = [
    '# Hotspot Risk Report',
    '',
    `${results.length} scored file${results.length === 1 ? '' : 's'}, ranked by risk ` +
      `(relative within this repo — not a literal "% buggy").`,
    '',
    '| # | File | Score | Tier | Trend | Commits | Churn | Authors | Ownership | Coupling | Complexity |' +
      (why ? ' Why |' : ''),
    '| - | ---- | ----: | ---- | ----- | ------: | ----: | ------: | --------: | -------: | ---------: |' +
      (why ? ' ---- |' : ''),
  ];
  results.forEach((r, i) => {
    const view = explanations?.get(r.path);
    lines.push(
      `| ${i + 1} | ${mdCell(r.path)} | ${r.score} | ${r.tier} | ${TREND_LABEL[r.trend]} | ` +
        `${r.signals.freq} | ${r.signals.churn} | ${r.signals.authors} | ` +
        `${Math.round(r.signals.ownership * 100)}% | ${Math.round(r.signals.coupling * 100)}% | ` +
        `${r.signals.complexity} |` +
        (why ? ` ${view ? mdCell(whyCell(view)) : '—'} |` : ''),
    );
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * JSON report: the results array, pretty-printed. Pure; exported for tests. When
 * `explanations` is supplied each entry gains an `explanation` object (per-signal
 * shares, dominant driver, additive-core %, and a plain-language summary); omit it
 * for the v0.4-identical raw array.
 */
export function buildJsonReport(
  results: readonly RiskResult[],
  explanations?: ReadonlyMap<string, ExplanationView>,
): string {
  if (explanations === undefined) {
    return JSON.stringify(results, null, 2);
  }
  const withExplain = results.map((r) => {
    const view = explanations.get(r.path);
    return {
      ...r,
      explanation: view
        ? {
            shares: view.shares,
            dominant: view.dominant,
            corePct: view.corePct,
            summary: view.sentence,
          }
        : null,
    };
  });
  return JSON.stringify(withExplain, null, 2);
}

type ExportFormat = 'markdown' | 'json';

/** Open the report in a new untitled editor of the right language. */
async function openReport(
  results: readonly RiskResult[],
  format: ExportFormat,
  explanations?: ReadonlyMap<string, ExplanationView>,
): Promise<void> {
  const content =
    format === 'json'
      ? buildJsonReport(results, explanations)
      : buildMarkdownReport(results, explanations);
  const doc = await vscode.workspace.openTextDocument({
    content,
    language: format === 'json' ? 'json' : 'markdown',
  });
  await vscode.window.showTextDocument(doc);
}

/** Register the `hotspot.exportReport` command (Markdown / JSON quick pick). */
export function registerExportReport(
  context: vscode.ExtensionContext,
  service: Pick<HotspotService, 'getResults' | 'getCoupledFiles'>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hotspot.exportReport', async () => {
      const results = service.getResults();
      if (results.length === 0) {
        void vscode.window.showInformationMessage(
          'Hotspot: nothing to export yet — run “Hotspot: Scan Workspace” first.',
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Markdown', detail: 'A ranked table you can paste into a PR or ticket.', format: 'markdown' as const },
          { label: 'JSON', detail: 'The raw results array for tooling.', format: 'json' as const },
        ],
        { placeHolder: 'Export the Hotspot risk report as…' },
      );
      if (!pick) {
        return; // user dismissed the quick pick
      }
      // Risk Explainability (S8-A): attach the per-file breakdown unless disabled.
      const cfg = vscode.workspace.getConfiguration('hotspot');
      const explanations = cfg.get<boolean>('explainEnabled', true)
        ? buildExplanations(results, effectiveWeights(cfg.get('weights')), (p) =>
            service.getCoupledFiles(p)[0]?.path,
          )
        : undefined;
      await openReport(results, pick.format, explanations);
    }),
  );
}
