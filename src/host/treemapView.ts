import * as vscode from 'vscode';

import type { HotspotService } from './scanService';
import { buildFolderTree, type TreemapNode } from '../core/folderTree';
import { buildExplanations, effectiveWeights } from '../core/explain';

// Risk Treemap Dashboard (S9) — the project's FIRST webview. A folder→file
// treemap where rectangle AREA = code volume (churn) and COLOR = risk tier;
// hovering a file reuses the S8-A explainability breakdown. DISPLAY-ONLY and
// opt-in (opened by the `hotspot.showTreemap` command) — it shifts no scores and
// stays completely inert until invoked.
//
// OFFLINE by construction (ADR — "100% local"): the webview HTML carries a strict
// CSP (`default-src 'none'` + a per-load nonce); the only loaded resources are the
// bundled `media/treemap.{js,css}` via `asWebviewUri`, with `localResourceRoots`
// pinned to `media/`. No remote origin, font, or CDN is reachable. The build-time
// grep tripwire (treemapOffline.test.ts) enforces this.

/** CSS color per tier for the webview rectangles — VS Code theme variables, so
 *  the treemap follows the active theme and ships zero color literals over the
 *  wire. `low` reuses a built-in chart color (no contributed `low` tier color). */
const TIER_COLORS: Record<string, string> = {
  critical: 'var(--vscode-hotspot-tierCritical)',
  high: 'var(--vscode-hotspot-tierHigh)',
  medium: 'var(--vscode-hotspot-tierMedium)',
  low: 'var(--vscode-charts-green)',
};

/** File-level hover payload: the S8-A breakdown, reused verbatim. */
interface FileExplain {
  sentence: string;
  line: string;
}

interface TreemapData {
  tree: TreemapNode;
  explanations: Record<string, FileExplain>;
  tierColors: Record<string, string>;
}

/** A cryptographically-irrelevant but unguessable nonce for the CSP script-src. */
function makeNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Build the webview HTML. Pure (no `vscode` calls) so the offline tripwire test
 * can render it with stub URIs and grep it for remote origins + assert the CSP.
 * `cspSource` is `webview.cspSource`; `scriptUri`/`styleUri` are `asWebviewUri`
 * results; `nonce` gates the inline `<script>` tag's `src`.
 */
export function buildTreemapHtml(opts: {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}): string {
  const { cspSource, nonce, scriptUri, styleUri } = opts;
  // default-src 'none' blocks EVERYTHING by default; we then re-allow only the
  // bundled style/script (style by cspSource, script by nonce). No img/font/connect
  // source is granted, so no remote fetch — offline guaranteed at runtime.
  const csp =
    `default-src 'none'; ` +
    `style-src ${cspSource}; ` +
    `script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Hotspot Risk Treemap</title>
</head>
<body>
  <header id="legend">
    <strong>Risk Treemap</strong>
    <span class="hint">area = code churn · color = risk tier · click a file to open it</span>
    <span class="caveat">Relative ranking within this repo — not a probability.</span>
  </header>
  <div id="empty" hidden>No scan results yet — run “Hotspot: Scan Workspace”, then reopen this view.</div>
  <div id="treemap" role="figure" aria-label="Folder and file risk treemap"></div>
  <div id="tooltip" role="tooltip" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * Whether a webview-supplied path is safe to open: it must be a repo-relative
 * path that cannot escape the workspace — no absolute prefix, no drive letter,
 * no `..` segment. The webview is a separate TRUST BOUNDARY (this is the
 * extension's first `onDidReceiveMessage` channel); although every `open` path
 * today comes from the trusted scan, the handler validates defensively so a
 * crafted message can never resolve a file outside the repo.
 */
export function isSafeRepoRelPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false; // posix-absolute
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false; // windows drive-absolute
  return !p.replace(/\\/g, '/').split('/').includes('..'); // no traversal
}

/** Glob metacharacters that would make a literal path be misread by `findFiles`. */
function hasGlobMeta(p: string): boolean {
  return /[*?[\]{}()!]/.test(p);
}

/** Resolve a repo-relative path to an absolute workspace URI (root-relative). */
function toUri(repoRelPath: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  return vscode.Uri.joinPath(folder.uri, ...repoRelPath.split('/'));
}

/** Open a file picked in the treemap; falls back to a workspace search, then a
 *  clear message — mirrors topHotspots.openHotspot so behavior is consistent. */
async function openFile(repoRelPath: string): Promise<void> {
  // Defense-in-depth on the webview trust boundary: never open a path that could
  // escape the workspace (`..`, absolute, drive-letter).
  if (!isSafeRepoRelPath(repoRelPath)) {
    return;
  }
  const uri = toUri(repoRelPath);
  if (uri) {
    try {
      await vscode.workspace.fs.stat(uri);
      await vscode.window.showTextDocument(uri);
      return;
    } catch {
      // fall through to a search
    }
  }
  // Only use the glob-based fallback for paths with NO glob metacharacters, so a
  // file literally named `foo[1].ts` is never misinterpreted as a search pattern.
  if (!hasGlobMeta(repoRelPath)) {
    const matches = await vscode.workspace.findFiles(repoRelPath, undefined, 1);
    if (matches.length > 0) {
      await vscode.window.showTextDocument(matches[0]);
      return;
    }
  }
  await vscode.window.showWarningMessage(
    `Hotspot: couldn't open "${repoRelPath}" — it may have moved or been deleted.`,
  );
}

/** Compute the data payload for the webview from the current results. */
function buildData(service: HotspotService): TreemapData {
  const results = service.getResults();
  const tree = buildFolderTree(results);
  const cfg = vscode.workspace.getConfiguration('hotspot');
  const views = buildExplanations(results, effectiveWeights(cfg.get('weights')), (p) =>
    service.getCoupledFiles(p)[0]?.path,
  );
  const explanations: Record<string, FileExplain> = {};
  for (const [path, v] of views) {
    explanations[path] = { sentence: v.sentence, line: v.line };
  }
  return { tree, explanations, tierColors: TIER_COLORS };
}

/**
 * Register the `hotspot.showTreemap` command. The webview is a singleton: a second
 * invocation reveals the existing panel rather than spawning another. The panel
 * refreshes on every scan while open, and is fully torn down on close (no work,
 * no listeners when it isn't open).
 */
export function registerTreemap(
  context: vscode.ExtensionContext,
  service: HotspotService,
): void {
  let panel: vscode.WebviewPanel | undefined;
  let updateSub: vscode.Disposable | undefined;

  const post = (): void => {
    panel?.webview.postMessage(buildData(service));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('hotspot.showTreemap', () => {
      if (panel) {
        panel.reveal();
        return;
      }
      panel = vscode.window.createWebviewPanel(
        'hotspot.treemap',
        'Hotspot Risk Treemap',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        },
      );
      const webview = panel.webview;
      const nonce = makeNonce();
      const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'treemap.js'),
      );
      const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'treemap.css'),
      );
      webview.html = buildTreemapHtml({
        cspSource: webview.cspSource,
        nonce,
        scriptUri: scriptUri.toString(),
        styleUri: styleUri.toString(),
      });

      const msgSub = webview.onDidReceiveMessage(
        (msg: { open?: string; ready?: boolean }) => {
          if (!msg) {
            return;
          }
          // Handshake: the script posts { ready: true } once its message listener
          // is attached, so the first data payload can't be lost to a load race.
          if (msg.ready) {
            post();
            return;
          }
          if (typeof msg.open === 'string') {
            void openFile(msg.open);
          }
        },
      );

      // Refresh while the panel is open. These panel-scoped listeners are disposed
      // on close — NOT pushed to context.subscriptions, which would leak a dead
      // entry per open→close cycle for the rest of the extension's lifetime.
      updateSub = service.onDidUpdate(() => post());

      panel.onDidDispose(() => {
        updateSub?.dispose();
        updateSub = undefined;
        msgSub.dispose();
        panel = undefined;
      });
    }),
  );
}
