# Media assets — capture checklist

The README references a demo GIF and screenshots that **a human must capture** (an agent
can't screen-record). This file is the shot list. Until these land, the README image links
render as broken thumbnails — capture them before the **v0.0.3** marketplace release.

Record against the mirror checkout `F:\Projects\hotspot` (no spaces in the path) on a repo
with real git history. Use a clean VS Code window (Dark+ theme, no unrelated extensions, no
personal info in the Explorer) at a readable zoom.

## Files to produce

| File | Type | Referenced in README | What to show |
| --- | --- | --- | --- |
| `media/demo.gif` | GIF | "Demo" hero | End-to-end flow: run **Hotspot: Scan Workspace** → Explorer tier badges appear → open the **Risk Report** panel → click the status-bar item to open **Show Top Hotspots** → pick a file → right-click in the editor → **Show Coupled Files** → pick a partner. |
| `media/risk-report.png` | PNG | "Demo" table (left) | The **Risk Report** activity-bar panel populated, with the colored tier icons and a tooltip visible (hover a row to show the signals line: commits · churn · authors · ownership · coupling). |
| `media/coupled-files.png` | PNG | "Demo" table (right) | The **Show Coupled Files** Quick Pick open over an editor, listing `$(git-merge) <strength%> · <path>` partner rows with the "co-changed N×" descriptions. |

> `media/icon.png` already exists (extension icon) — do not overwrite it.

## Suggested specs

- **GIF:** ≤ ~8 MB (GitHub inlines it; keep it snappy), ~1280×720 or the editor viewport,
  10–15 fps, 15–25 s. Trim dead air. Tools: ScreenToGif / LICEcap / Kap.
- **PNG screenshots:** actual-size, ≤ ~1600 px wide, lossless PNG. Crop to the relevant panel
  plus a little editor context.
- Keep file names exactly as above so the README links resolve.

## After capturing

1. Drop the files into `media/`.
2. Confirm `.vscodeignore` does **not** exclude `media/*.png` / `media/*.gif` (the marketplace
   listing needs them; the GIF can be large — consider excluding only `media/demo.gif` from the
   packaged `.vsix` if size is a concern, while keeping it on GitHub).
3. Re-render the README preview to verify every image resolves.
