import * as vscode from 'vscode';

import type { HotspotService } from './scanService';
import type { RiskResult } from '../core/scorer';

// Export Risk Report (S7-A2): dump the current ranking as Markdown or JSON into a
// new untitled editor (non-destructive — the user saves where they like). Lets a
// scan leave the editor: paste into a PR, a ticket, or a code-review checklist.

const TREND_LABEL: Record<RiskResult['trend'], string> = {
  rising: '↑ rising',
  stable: '→ stable',
  cooling: '↓ cooling',
};

/** Markdown report: a ranked table + a one-line framing note. Pure; exported for tests. */
export function buildMarkdownReport(results: readonly RiskResult[]): string {
  const lines = [
    '# Hotspot Risk Report',
    '',
    `${results.length} scored file${results.length === 1 ? '' : 's'}, ranked by risk ` +
      `(relative within this repo — not a literal "% buggy").`,
    '',
    '| # | File | Score | Tier | Trend | Commits | Churn | Authors | Ownership | Coupling | Complexity |',
    '| - | ---- | ----: | ---- | ----- | ------: | ----: | ------: | --------: | -------: | ---------: |',
  ];
  results.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.path} | ${r.score} | ${r.tier} | ${TREND_LABEL[r.trend]} | ` +
        `${r.signals.freq} | ${r.signals.churn} | ${r.signals.authors} | ` +
        `${Math.round(r.signals.ownership * 100)}% | ${Math.round(r.signals.coupling * 100)}% | ` +
        `${r.signals.complexity} |`,
    );
  });
  lines.push('');
  return lines.join('\n');
}

/** JSON report: the raw results array, pretty-printed. Pure; exported for tests. */
export function buildJsonReport(results: readonly RiskResult[]): string {
  return JSON.stringify(results, null, 2);
}

type ExportFormat = 'markdown' | 'json';

/** Open the report in a new untitled editor of the right language. */
async function openReport(results: readonly RiskResult[], format: ExportFormat): Promise<void> {
  const content =
    format === 'json' ? buildJsonReport(results) : buildMarkdownReport(results);
  const doc = await vscode.workspace.openTextDocument({
    content,
    language: format === 'json' ? 'json' : 'markdown',
  });
  await vscode.window.showTextDocument(doc);
}

/** Register the `hotspot.exportReport` command (Markdown / JSON quick pick). */
export function registerExportReport(
  context: vscode.ExtensionContext,
  service: Pick<HotspotService, 'getResults'>,
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
      await openReport(results, pick.format);
    }),
  );
}
