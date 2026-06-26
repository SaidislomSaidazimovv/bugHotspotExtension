import * as vscode from 'vscode';

import type { HotspotService } from './scanService';
import type { RiskTier } from '../core/scorer';

// Explorer file decorations: a short badge + tier ThemeColor on risky files.
// Colors are defined in package.json `contributes.colors` (hotspot.tier*), so
// they adapt to the user's theme. `propagate: true` bubbles the color up to
// containing folders so hot areas are visible while collapsed.

interface TierStyle {
  badge: string;
  colorId: string;
}

// Low tier is intentionally undecorated to avoid Explorer noise.
const TIER_STYLES: Partial<Record<RiskTier, TierStyle>> = {
  critical: { badge: '!!', colorId: 'hotspot.tierCritical' },
  high: { badge: '!', colorId: 'hotspot.tierHigh' },
  medium: { badge: '·', colorId: 'hotspot.tierMedium' },
};

class HotspotDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  constructor(private readonly service: HotspotService) {}

  /** Re-evaluate all decorations (called after each scan). */
  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    // asRelativePath yields the workspace-relative path (== repo-relative when
    // the workspace root is the repo root); normalize to ChurnMap key form.
    const relPath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const result = this.service.getResultForPath(relPath);
    if (!result) {
      return undefined;
    }
    const style = TIER_STYLES[result.tier];
    if (!style) {
      return undefined;
    }
    return {
      badge: style.badge,
      color: new vscode.ThemeColor(style.colorId),
      tooltip: `Hotspot risk: ${result.tier} (score ${result.score})`,
      propagate: true,
    };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/** Register the Explorer decoration provider and refresh it after each scan. */
export function registerDecorations(
  context: vscode.ExtensionContext,
  service: HotspotService,
): void {
  const provider = new HotspotDecorationProvider(service);
  context.subscriptions.push(
    provider,
    vscode.window.registerFileDecorationProvider(provider),
    service.onDidUpdate(() => provider.refresh()),
  );
}
