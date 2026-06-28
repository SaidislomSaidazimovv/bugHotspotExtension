// Risk Treemap (S9) — vanilla squarified treemap. ZERO dependencies, ZERO remote
// resources (no SVG namespace, no remote bundles, no web fonts). Renders DIV tiles
// by a squarified layout (Bruls et al.): area = code churn, color = risk tier.
// Runs inside a VS Code webview under a strict CSP (script gated by nonce).

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const container = document.getElementById('treemap');
  const emptyEl = document.getElementById('empty');
  const tooltip = document.getElementById('tooltip');

  /** Last data posted by the host, kept so a resize can re-layout without a round-trip. */
  let data = null;
  let rafPending = false;

  // ---- Squarified layout -------------------------------------------------

  /** Worst (largest) aspect ratio in a candidate row laid across `shortSide`. */
  function worstRatio(row, sum, shortSide) {
    const thickness = sum / shortSide;
    let worst = 1;
    for (const it of row) {
      const side = it.area / thickness;
      const ratio = thickness > side ? thickness / side : side / thickness;
      if (ratio > worst) worst = ratio;
    }
    return worst;
  }

  /**
   * Squarify `items` (each { node, area } already scaled to pixel² ) into the
   * rectangle `rect` {x,y,w,h}. Returns [{ node, x, y, w, h }].
   */
  function squarify(items, rect) {
    const out = [];
    let x = rect.x;
    let y = rect.y;
    let w = rect.w;
    let h = rect.h;
    let i = 0;
    while (i < items.length && w > 0.5 && h > 0.5) {
      const shortSide = Math.min(w, h);
      const row = [];
      let sum = 0;
      // Grow the row while adding the next item does not worsen the aspect ratio.
      while (i < items.length) {
        const next = items[i];
        const cur = row.length ? worstRatio(row, sum, shortSide) : Infinity;
        const grown = worstRatio(row.concat(next), sum + next.area, shortSide);
        if (row.length === 0 || grown <= cur) {
          row.push(next);
          sum += next.area;
          i++;
        } else {
          break;
        }
      }
      // Place the row across the short side, consuming the long side by `thickness`.
      if (w <= h) {
        const thickness = sum / w; // height of the horizontal strip
        let cx = x;
        for (const it of row) {
          const iw = it.area / thickness;
          out.push({ node: it.node, x: cx, y: y, w: iw, h: thickness });
          cx += iw;
        }
        y += thickness;
        h -= thickness;
      } else {
        const thickness = sum / h; // width of the vertical strip
        let cy = y;
        for (const it of row) {
          const ih = it.area / thickness;
          out.push({ node: it.node, x: x, y: cy, w: thickness, h: ih });
          cy += ih;
        }
        x += thickness;
        w -= thickness;
      }
    }
    return out;
  }

  // ---- Rendering ---------------------------------------------------------

  function tierColor(tier) {
    const colors = data.tierColors || {};
    return colors[tier] || colors.low || 'gray';
  }

  function addLabel(el, text) {
    const span = document.createElement('span');
    span.className = 'label';
    span.textContent = text;
    el.appendChild(span);
  }

  function layoutNode(node, rect) {
    const kids = node.children;
    if (!kids || kids.length === 0) return;
    const totalArea = kids.reduce((s, c) => s + Math.max(c.area, 0), 0);
    if (totalArea <= 0) return;
    const scale = (rect.w * rect.h) / totalArea;
    const items = kids.map((c) => ({ node: c, area: Math.max(c.area, 0) * scale }));
    const tiles = squarify(items, rect);

    for (const t of tiles) {
      if (t.w < 1 || t.h < 1) continue; // sub-pixel: not worth a node
      const el = document.createElement('div');
      el.className = 'tile ' + (t.node.isFile ? 'file' : 'folder');
      el.style.left = t.x + 'px';
      el.style.top = t.y + 'px';
      el.style.width = t.w + 'px';
      el.style.height = t.h + 'px';

      if (t.node.isFile) {
        el.style.backgroundColor = tierColor(t.node.tier);
        el.tabIndex = 0;
        if (t.w > 34 && t.h > 14) addLabel(el, t.node.name);
        el.addEventListener('click', () => vscode.postMessage({ open: t.node.path }));
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            vscode.postMessage({ open: t.node.path });
          }
        });
        el.addEventListener('mousemove', (e) => showTooltip(e, t.node));
        el.addEventListener('mouseleave', hideTooltip);
        container.appendChild(el);
      } else {
        const showHeader = t.w > 40 && t.h > 18;
        if (showHeader) addLabel(el, t.node.name + '/');
        container.appendChild(el);
        const header = showHeader ? 15 : 1;
        const inner = { x: t.x + 1, y: t.y + header, w: t.w - 2, h: t.h - header - 1 };
        if (inner.w > 2 && inner.h > 2) layoutNode(t.node, inner);
      }
    }
  }

  function render() {
    rafPending = false;
    if (!data) return;
    container.innerHTML = '';
    const tree = data.tree;
    const hasFiles = tree && tree.children && tree.children.length > 0;
    emptyEl.hidden = hasFiles;
    container.hidden = !hasFiles;
    if (!hasFiles) return;
    const rect = { x: 0, y: 0, w: container.clientWidth, h: container.clientHeight };
    if (rect.w < 4 || rect.h < 4) return;
    layoutNode(tree, rect);
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(render);
  }

  // ---- Tooltip -----------------------------------------------------------

  function showTooltip(e, node) {
    const ex = data.explanations ? data.explanations[node.path] : undefined;
    const parts = [];
    parts.push('<div class="tt-path">' + escapeHtml(node.path) + '</div>');
    parts.push(
      '<div class="tt-meta">Risk ' + node.score + ' · ' + escapeHtml(node.tier) + '</div>',
    );
    if (ex) {
      parts.push('<div>' + escapeHtml(ex.sentence) + '</div>');
      if (ex.line) parts.push('<div class="tt-line">' + escapeHtml(ex.line) + '</div>');
    }
    tooltip.innerHTML = parts.join('');
    tooltip.hidden = false;
    // Position near the cursor, clamped to the viewport.
    const pad = 12;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let left = e.clientX + pad;
    let top = e.clientY + pad;
    if (left + tw > window.innerWidth) left = e.clientX - tw - pad;
    if (top + th > window.innerHeight) top = e.clientY - th - pad;
    tooltip.style.left = Math.max(0, left) + 'px';
    tooltip.style.top = Math.max(0, top) + 'px';
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- Wiring ------------------------------------------------------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.tree) {
      data = msg;
      scheduleRender();
    }
  });

  window.addEventListener('resize', scheduleRender);

  // Tell the host we're ready to receive the first payload (avoids a load race).
  vscode.postMessage({ ready: true });
})();
