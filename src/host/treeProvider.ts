import * as vscode from 'vscode';
import * as path from 'node:path';

import type { HotspotService } from './scanService';
import type { RiskResult, RiskTier, RiskTrend } from '../core/scorer';
import {
  buildExplanations,
  effectiveWeights,
  type ExplanationView,
} from '../core/explain';

// "Risk Report" side-panel: a flat list of files ranked by hotspot score
// (highest first). Backed by HotspotService.getResults(); refreshes on scan.

const TIER_COLOR: Partial<Record<RiskTier, string>> = {
  critical: 'hotspot.tierCritical',
  high: 'hotspot.tierHigh',
  medium: 'hotspot.tierMedium',
};

/** Momentum arrow for a result's trend (S7-A2 / S7-B1). */
const TREND_ARROW: Record<RiskTrend, string> = {
  rising: '↑',
  stable: '→',
  cooling: '↓',
};

/** Plain-language trend tooltip line (display-only; trend never feeds the score). */
const TREND_TOOLTIP: Record<RiskTrend, string> = {
  rising: 'trend ↑ rising — most of this file’s commits are recent',
  stable: 'trend → stable — steady change over its history',
  cooling: 'trend ↓ cooling — little recent activity',
};

/** Compact trend badge for a tree row description (S7-A2). Exported for tests. */
export function trendBadge(trend: RiskTrend): string {
  return TREND_ARROW[trend];
}

// Cold-start confidence (S7-A2): a repo with very few scored files, or whose
// hottest file barely scores, can't produce a trustworthy ranking — surface a
// note instead of letting users over-read the noise.
const MIN_CONFIDENT_FILES = 5;
const MIN_CONFIDENT_TOP_SCORE = 15;

/**
 * A low-confidence note when the result set is too thin to trust (fewer than
 * {@link MIN_CONFIDENT_FILES} scored files, or a top score below
 * {@link MIN_CONFIDENT_TOP_SCORE}), else `undefined`. Empty results return
 * `undefined` (the view's welcome content already covers the "no scan" case).
 * Pure; exported for tests + reused by the status bar.
 */
export function confidenceNote(results: readonly RiskResult[]): string | undefined {
  if (results.length === 0) {
    return undefined;
  }
  const topScore = results[0].score; // results are sorted desc by score
  if (results.length < MIN_CONFIDENT_FILES || topScore < MIN_CONFIDENT_TOP_SCORE) {
    return '⚠ Low confidence — thin git history; rankings may be noisy.';
  }
  return undefined;
}

function tierIcon(tier: RiskTier): vscode.ThemeIcon {
  const colorId = TIER_COLOR[tier];
  return colorId
    ? new vscode.ThemeIcon('flame', new vscode.ThemeColor(colorId))
    : new vscode.ThemeIcon('circle-outline');
}

class RiskReportProvider implements vscode.TreeDataProvider<RiskResult> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * Risk Explainability breakdown (S8-A), lazily built once per refresh and
   * keyed by path. `undefined` ⇒ not yet computed for the current result set;
   * an empty map ⇒ explainability is disabled. Recomputing once (not per row)
   * keeps the whole-set `normalize` out of the O(N²) trap.
   */
  private explanations?: Map<string, ExplanationView>;

  constructor(private readonly service: HotspotService) {}

  refresh(): void {
    this.explanations = undefined; // invalidate: rebuild against the new results
    this._onDidChangeTreeData.fire();
  }

  /** Build (and cache) the explanation breakdown for the current results, unless
   *  `hotspot.explainEnabled` is off (then an empty map ⇒ no "why" block). */
  private getExplanations(): Map<string, ExplanationView> {
    if (this.explanations) {
      return this.explanations;
    }
    const cfg = vscode.workspace.getConfiguration('hotspot');
    const enabled = cfg.get<boolean>('explainEnabled', true);
    this.explanations = enabled
      ? buildExplanations(
          this.service.getResults(),
          effectiveWeights(cfg.get('weights')),
          (p) => this.service.getCoupledFiles(p)[0]?.path,
        )
      : new Map();
    return this.explanations;
  }

  getChildren(element?: RiskResult): RiskResult[] {
    // Flat list: only the root has children.
    return element ? [] : this.service.getResults();
  }

  getTreeItem(result: RiskResult): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.posix.basename(result.path),
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${result.score} · ${result.tier} ${trendBadge(result.trend)}`;
    const lines = [
      `**${result.path}**`,
      '',
      `Risk **${result.score}** · ${result.tier} _(relative ranking, not "% buggy")_`,
      '',
      `commits ${result.signals.freq} · churn ${result.signals.churn} · ` +
        `authors ${result.signals.authors} · ` +
        `ownership ${Math.round(result.signals.ownership * 100)}% fragmented · ` +
        `coupling ${Math.round(result.signals.coupling * 100)}% · ` +
        `complexity ${result.signals.complexity}`,
      '',
      `_${TREND_TOOLTIP[result.trend]}_`,
    ];
    // Risk Explainability breakdown (S8-A): decompose the additive core into each
    // signal's % share + a plain-language "why". Gated by `hotspot.explainEnabled`.
    const explanation = this.getExplanations().get(result.path);
    if (explanation) {
      lines.push('', '**Why this score?**', explanation.sentence);
      // Thin-history files (no dominant driver) have an all-"0%" breakdown line —
      // show only the neutral sentence, omit the noisy "freq 0% · churn 0% · …".
      if (explanation.dominant !== null) {
        lines.push('', explanation.line);
      }
    }
    item.tooltip = new vscode.MarkdownString(lines.join('\n'));
    item.iconPath = tierIcon(result.tier);
    item.contextValue = 'hotspotRisk';

    const uri = this.toUri(result.path);
    if (uri) {
      // Drives the file-type icon + lets the FileDecorationProvider tint the row.
      item.resourceUri = uri;
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [uri],
      };
    }
    return item;
  }

  private toUri(repoRelPath: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, ...repoRelPath.split('/'));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

/** Register the "Risk Report" tree view and refresh it after each scan. */
export function registerRiskPanel(
  context: vscode.ExtensionContext,
  service: HotspotService,
): void {
  const provider = new RiskReportProvider(service);
  const view = vscode.window.createTreeView('hotspot.riskReport', {
    treeDataProvider: provider,
  });
  // Surface the cold-start confidence note (S7-A2) above the list when the
  // ranking is too thin to trust; clear it otherwise.
  const syncMessage = (): void => {
    view.message = confidenceNote(service.getResults());
  };
  syncMessage();
  context.subscriptions.push(
    view,
    provider,
    service.onDidUpdate(() => {
      provider.refresh();
      syncMessage();
    }),
    // Toggling the explainability setting changes the tooltip content but not the
    // ranking, so refresh the tree (rebuilds the breakdown) without a rescan.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hotspot.explainEnabled')) {
        provider.refresh();
      }
    }),
  );
}
