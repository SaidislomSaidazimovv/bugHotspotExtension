import * as vscode from 'vscode';
import * as path from 'node:path';

import type { HotspotService } from './scanService';
import type { RiskResult, RiskTier } from '../core/scorer';

// "Risk Report" side-panel: a flat list of files ranked by hotspot score
// (highest first). Backed by HotspotService.getResults(); refreshes on scan.

const TIER_COLOR: Partial<Record<RiskTier, string>> = {
  critical: 'hotspot.tierCritical',
  high: 'hotspot.tierHigh',
  medium: 'hotspot.tierMedium',
};

function tierIcon(tier: RiskTier): vscode.ThemeIcon {
  const colorId = TIER_COLOR[tier];
  return colorId
    ? new vscode.ThemeIcon('flame', new vscode.ThemeColor(colorId))
    : new vscode.ThemeIcon('circle-outline');
}

class RiskReportProvider implements vscode.TreeDataProvider<RiskResult> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly service: HotspotService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
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
    item.description = `${result.score} · ${result.tier}`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${result.path}**`,
        '',
        `Risk **${result.score}** · ${result.tier} _(relative ranking, not "% buggy")_`,
        '',
        `commits ${result.signals.freq} · churn ${result.signals.churn} · ` +
          `authors ${result.signals.authors} · ` +
          `ownership ${Math.round(result.signals.ownership * 100)}% fragmented · ` +
          `complexity ${result.signals.complexity}`,
      ].join('\n'),
    );
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
  context.subscriptions.push(
    view,
    provider,
    service.onDidUpdate(() => provider.refresh()),
  );
}
