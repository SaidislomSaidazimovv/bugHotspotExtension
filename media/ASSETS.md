# Media assets — capture checklist

The README references screenshots that **a human must capture** (an agent can't
screen-record). This file is the shot list. Until they land, the README image
links render as broken thumbnails — capture them before the **v0.0.3** release.

No GIF for now (deferred) — **static PNGs only**, arranged as a CMake-Tools-style
2-column feature grid plus one hero image.

Capture against the mirror checkout `F:\Projects\hotspot` (no spaces in the path)
on a repo with real git history. Use a clean VS Code window: **Dark+** theme, no
unrelated extensions, no personal info in the Explorer, a readable zoom.

## Files to produce

| File | Referenced in README | What to show |
| --- | --- | --- |
| `media/hero.png` | Hero (top, centered, ~850px) | The "money shot": the **Risk Report** panel open on the left **and** an editor showing a file with **code-level risk** gutter marks + a visible hover — one frame that captures the whole product. |
| `media/risk-report.png` | Features grid (row 1, left) | The **Risk Report** panel populated, tier icons visible, hovering a row so the per-signal tooltip shows (`commits · churn · authors · ownership · coupling · complexity`). |
| `media/code-risk.png` | Features grid (row 1, right) | An editor with a deeply-nested block: the **gutter marker** + faint line tint on the risky region, and the **hover** open ("🔥 Risky code (high) — deeply nested…"). |
| `media/top-hotspots.png` | Features grid (row 2, left) | The **Show Top Hotspots** Quick Pick open, showing the 5-signal description line + the plain-language `detail` under each item. |
| `media/coupled-files.png` | Features grid (row 2, right) | The **Show Coupled Files** Quick Pick open over an editor, listing `$(git-merge) <strength%> · <path>` rows with "co-changed N×". |
| `media/explorer-badges.png` | Features grid (row 3, left) | The file **Explorer** with colored risk-tier badges on several files. |
| `media/status-bar.png` | Features grid (row 3, right) | The bottom **status bar** showing `$(flame) Hotspot: <score> (<tier>)` for the active file (crop to the status bar + a little editor). |

> `media/icon.png` already exists (extension icon) — do not overwrite it.

## Suggested specs

- **PNG screenshots:** actual-size, lossless PNG. The hero ~1600px wide; the grid
  shots ~800–1000px wide (they render at 49% side-by-side). Crop tight to the
  relevant panel plus a little editor context.
- Keep file names **exactly** as above so the README `<img>` links resolve.

## After capturing

1. Drop the files into `media/`.
2. Confirm `.vscodeignore` does **not** exclude `media/*.png` (the marketplace
   listing needs them).
3. Re-render the README preview to verify every image resolves.
4. (Later) a hero GIF can replace `media/hero.png` if desired — deferred for now.
