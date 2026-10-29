# ERP-IA · UI density, keyboard and stream-stability audit (phase 1)

Date: 2026-10-28 · Branch `phase-1-qa` (HEAD `ad5f6bd` plus the uncommitted working tree of the same day) · Read-only audit; nothing in the repo was changed except this report.
Binding inputs: `docs/project-rules.md` (rules 19–25), design §19a, prototype v5 `docs/superpowers/specs/2026-10-27-erp-ia-phase1-prototype.html`.


> **Prototype:** the recommendations of this audit are assembled into a clickable prototype, `docs/superpowers/specs/2026-10-28-erp-ia-prototype-v6-density.html` ("v6 · densidad"), with a v5 → v6 panel that switches each owner decision on and off. Prototype v5 stays the contract until the owner ratifies the decisions in §3.

## 1. Executive summary

1. The shell, grid and record frame follow prototype v5 closely (48 px navy bar, 36 px tabs row, 400 px drawer, 36 px rows, tabular money). The friction is in **keyboard paths, focus visibility and layout stability**, not in the look.
2. Keyboard work is blocked in three places: file choosers that cannot be reached with Tab, a grid where each row and each checkbox is a tab stop (about 100 stops on a 50-row page), and live-result rows in the advanced filter that only a mouse can pick.
3. The focus ring token `--focus` #93C5FD reaches **1.80:1** on white, and the base rule paints it at 50 % (**1.33:1**). Both are under the 3:1 that WCAG 1.4.11 and 2.4.13 require. Several controls have no focus style of their own.
4. Data-entry forms have no save shortcut and no `<form>` submit. After a refused save, focus stays on the button, and every field error is its own `role="alert"`.
5. Admin matrices jump: each checkbox writes at once, then a status banner is inserted *above* the table and pushes it about 40 px down. Each sensitive toggle also uses up a single-use TOTP verification (`packages/kernel/src/process/run.ts:144,237`), so the admin types a code for every cell.
6. Streaming surfaces lack a stable frame. The assistant log jumps to the bottom on every token, and `role="log"` reads each delta aloud. The typing row appears and disappears. Import polling runs without showing it, stops for good after one network error, and never says whether it is live or paused.
7. Snapshot surfaces never say how old their data is (home KPIs, import history), and the first load shows "0 registros" before any rows arrive. The pages render `Suspense fallback={null}` and the app has no `loading.tsx`, so they appear in one jump.
8. Exports running as background jobs are aborted when the user changes tab, because the grid unmounts and `use-grid-export.ts:43` aborts the poll. Nothing tells the user.
9. In dark theme, white text on `--primary` #3B82F6 reaches only **3.68:1** (buttons, pager, user bubbles). Input borders sit at 1.39:1 (light) and 1.34:1 (dark), so empty inputs barely read as fields.
10. Most fixes stay within the v5 contract (CSS over tokens, small TSX changes). Twelve proposals change prototype v5, a token value or a contract, or need a new process; they are listed under §3 for the owner, and the quick wins under §4.

| # | Sev. | File (file:line) | Friction |
|---|---|---|---|
| H1 | High | `packages/ui/src/attachments-panel.tsx:237-247`, `record/PhotosTab.tsx:283-289`, `import/ImportDialog.tsx:190-201` | File choosers are `<input hidden>` inside a `<label>` that cannot take focus, so keyboard users cannot add files (the new `:focus-within` rule never fires on a `display:none` input). |
| H2 | High | `packages/ui/src/grid/DataGrid.tsx:242-253` | Every row has `tabIndex=0` and its own checkbox: 2 × N tab stops, no arrow keys, no roving tabindex. |
| H3 | High | `styles/tokens.css:9`, `styles/globals.css:94`, `components.css:32,63,74`, `shell/TabsBar.tsx:61`, `shell/ModuleBar.tsx:38` | The focus ring is 1.80:1 (1.33:1 at the base rule's 50 % alpha). The filter row, tabs and module items have no focus style of their own. |
| H4 | High | `admin/permissions/permission-matrix.tsx:44`, `admin/fields/fields-screen.tsx:54`, `_components/use-step-up.tsx:24` | A status banner inserted above the matrix after each toggle shifts the table, so the next click can land on the wrong cell. Each cell asks for its own TOTP code. |
| H5 | High | `forms/PartyForm.tsx:117-306`, `forms/form-parts.tsx:36-40,291` | No `<form>`, no Ctrl/⌘+S. After a refusal, focus is not moved to the first error, and N field alerts are read at once. |
| H6 | High | `assistant/MessageList.tsx:46-49,120` | The log scrolls to the bottom on every streamed token, even after the user scrolled up to read. `role="log"` announces every delta. |
| H7 | High | `grid/use-grid-export.ts:43`, `shell/AppShell.tsx:128-136` | Switching tab unmounts the grid and aborts a background export job without telling the user. |
| H8 | High | `grid/AdvancedFilter.tsx:136-142` | Live-result rows (rule 20 "row pick", also used by the lookups) have `onClick` only: no tabIndex, no Enter. |
| H9 | High | `shell/TabsBar.tsx:41` | The tabs row is `overflow-hidden`, so tabs past the right edge cannot be seen or reached. |
| H10 | High | `styles/components.css` (HEAD) | At HEAD the Contactos, Fotos, Datos adicionales and Archivos tabs used `erp-*` classes that no stylesheet defined. **Fixed in the working tree by the concurrent edit (+101 lines, uncommitted); verify and commit.** |
| M1 | Med | `app/(app)/import/import-page.tsx:23-33` | Polling every 3 s is not shown on screen, keeps running in hidden tabs and stops forever after one failed fetch (status stays "en curso"). |
| M2 | Med | `grid/DataGrid.tsx:101,153,260`, `grid/use-grid.ts:34`, `app/(app)/layout.tsx:33`, every `page.tsx` | The first load shows "0 registros" and "0–0 de 0" with an empty body, then rows jump in. No skeleton, no `loading.tsx`. |
| M3 | Med | `grid/DataGrid.tsx:179-184`, `components.css:50,53` | The export status and the "Limpiar filtros" button mount and unmount inside a wrapping flex header, which reflows the whole grid. |
| M4 | Med | `grid/GridFooter.tsx:27,55-69`, `components.css:77` | Footer totals are loose text, not under their columns. The footer wraps when a selection appears, so the body shrinks. |
| M5 | Med | `components.css:59-62` | No sticky identity column: on wide party grids the name scrolls out of view. |
| M6 | Med | `styles/tokens.css:15-28`, `components.css:34,82,157,239` | Dark theme: white on #3B82F6 is 3.68:1 and dark links are 4.49:1. Input borders are 1.39:1 (light) and 1.34:1 (dark). |
| M7 | Med | `assistant/StepUpField.tsx:56-74`, `forms/StepUpPrompt.tsx:24-33`, `assistant/ConfirmationCard.tsx:111` | Code boxes: no autofocus, no auto-verify at 6 digits, no Esc. After verifying, focus does not move to Confirmar. |
| M8 | Med | `grid/use-popover.ts:14-16`, `grid/SavedViewsMenu.tsx:61` | Popovers neither move focus in nor return it on Esc. ✕ deletes a saved view with no confirmation. |
| M9 | Med | `grid/FilterRow.tsx:78-86`, `components.css:64` | No Esc to clear, no Enter to apply at once, no `/` to focus. An active filter is shown by colour alone. |
| M10 | Med | `admin/permissions/permission-matrix.tsx:47-58,84-90` | Three text columns before the roles, none sticky. 16 px checkbox targets, no row hover. |
| M11 | Med | `home/KpiCard.tsx:20-39`, `home/Widget.tsx:74`, `home/widgets.tsx:97-128` | KPIs show no "as of" time and no trend. Each widget header shows "4/4 · 170 px". The recent-records table has no styles. |
| M12 | Med | `forms/PartyForm.tsx:150,168,223`, `forms/form-parts.tsx:31-40` | Municipality is a native select with about 1,100 options. DV and the composed name are `disabled` (not readable, not copyable). No `aria-describedby`. |
| M13 | Med | `shell/AppShell.tsx:159,211`, `shell/TopBar.tsx:156` | No skip-to-content link. The Asistente button has no `aria-expanded` and no shortcut. The drawer is open by default even on narrow screens. |
| M14 | Med | `app/(app)/r/[entity]/[id]/files-panel.tsx:25`, `attachments-panel.tsx:326-345` | `common.attachments.*` exists in i18n but is not passed, so `en` users see Spanish. Upload time is a UTC ISO slice. The remove confirmation does not manage focus. |
| M15 | Med | `assistant/MessageList.tsx:132-139`, `assistant/Composer.tsx:30-41`, `assistant/AssistantDrawer.tsx:65-78` | The typing row mounts and unmounts (layout shift). No "Respondiendo" state in the header. Single-line input. Esc does not stop a turn. |
| M16 | Med | `import/ImportDialog.tsx:206,233-251` | The preview has no "only rows with errors" view. Error text wraps rows to unpredictable heights. |
| L1 | Low | `shell/TopBar.tsx:146` | The notification dot shows even when the list is empty: a false, colour-only signal. |
| L2 | Low | `components.css:68` | The unsorted glyph at 30 % opacity reaches 1.66:1. |
| L3 | Low | `record/RecordFrame.tsx:45-51` | Record tabs lack Home/End. |
| L4 | Low | `admin/ai-usage/ai-usage-screen.tsx:35-46` | 8 px allowance bar, no 80 %/100 % ticks, the percentage is not written out. |
| L5 | Low | `shell/TabsBar.tsx:66-73` | The tab close ✕ is a target of about 12 px. |
| L6 | Low | `components.css:140-143,250-252` | No `prefers-reduced-motion` for the blink, toggles or drop zones. |
| L7 | Low | `assistant/ConfirmationCard.tsx:67-83`, `components.css:261` | Effect values (amounts, ids) do not use tabular figures. |
| L8 | Low | `components.css:81` | 26 px pager buttons on touch (rule 24: 44 px on POS/mobile). |
| L9 | Low | `home/Widget.tsx:60-70` | The widget header is `role="button"` with no Enter action; Alt+arrows are only explained in a `title`. |
| L10 | Low | `grid/DataGrid.tsx:33-49` | The "Archivo listo" export status stays in the header for good, with no way to dismiss it. |

**Totals: 10 High · 16 Medium · 10 Low.** Already fixed in the working tree, not counted: the raw `dian_status` enum in the record footer (now `record-status.tsx` with `common.record.dian.*`).

### Method and the "Tailwind utilities only" constraint

The brief asks for "Tailwind utilities only", and the repo does not work that way. It styles with Tailwind v4 utilities (shell, palette, top bar) **and** a shared `packages/ui/src/styles/components.css` of `erp-*` classes over `tokens.css` (grid, forms, record, assistant, admin). The proposals below fit the repo instead. They use utilities where a file already does (`shell/*`), and `erp-*` rules over tokens where a file uses those. Moving everything to utilities would mean abandoning `components.css`. That is an architecture decision for the owner, and I do not recommend it (OD-8).

Contrast was computed from `tokens.css` with the WCAG 2.x relative-luminance formula (script kept outside the repo):

| Pair (light) | Ratio | Pair (dark) | Ratio |
|---|---|---|---|
| `--text-muted` / `--surface` | 9.40 ✓ | `--text-muted` / `--surface` | 7.29 ✓ |
| `--focus` / `--surface` (ring) | **1.80 ✗** | `--focus` / `--surface` | 6.50 ✓ |
| `--focus` at 50 % (base rule) | **1.33 ✗** | `--focus` at 50 % | **2.64 ✗** |
| `--focus` / `--bar` (ring in top bar) | 5.74 ✓ | white / `--primary` (#3B82F6) | **3.68 ✗** (13 px text) |
| `--line` / `--surface` (input border) | **1.39 ✗** | `--line` / `--surface` | **1.34 ✗** |
| `--accent` / `--surface` (selected row) | 1.22 (paired with the checkbox) | `--primary` / `--surface` (links) | 4.49 (just short) |
| `--tabrow-text` / `--tabrow` | 7.65 ✓ | `--primary` / `--accent` (`.erp-lk__mag.is-on`) | **2.82 ✗** |
| pills ok/warn/danger/info | 7.54 / 7.11 / 7.45 / 6.83 ✓ | pills ok/warn/danger/info | 8.17 / 8.07 / 7.45 / 7.59 ✓ |
| proposed `--focus-ring` #1D4ED8 / surface | 6.70 ✓ | proposed `--focus-ring` #60A5FA / surface | 6.50 ✓ |
| proposed `--line-input` #8A94A3 / surface | 3.07 ✓ | proposed `--line-input` #6B7686 / surface | 3.59 ✓ |
| | | proposed `--primary` #2563EB, white text | 5.17 ✓ |

### Prototype harness (shared by every "Pure Tailwind & SVG Prototype Block")

Each prototype block below is an HTML fragment. To view one on its own, paste it into the `<body>` of this harness. Inside the app the same class names resolve through `@erp/ui/globals.css`; `outline-focus-ring` and `border-line-input` resolve once the globals.css diff in §2.2 lands. Colours come only from the token table, so light, dark and automatic all work. To force a theme, set `data-theme="dark"` or `data-theme="light"` on `<html>`.

```html
<!doctype html>
<html lang="es-419">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.11"></script>
<style>
:root{--bar:#1E3A8A;--bar-ctl:#2A4A9E;--bar-line:#4A6AC2;--bar-text:#DBE4F5;--bar-dim:#9DB0DC;--primary:#1D4ED8;--primary-h:#1E40AF;--accent:#DBEAFE;--accent-line:#BFDBFE;--focus:#93C5FD;--focus-ring:#1D4ED8;--line-input:#8A94A3;--bg:#EEF0F2;--surface:#FFFFFF;--head:#F7F8FA;--hover:#F3F6FC;--tabrow:#D6E0F5;--tabrow-line:#B5C4E6;--tabrow-text:#2B3F75;--tabrow-hover:#C6D4F0;--text:#1A1D21;--text-muted:#3F4752;--line:#D7DBE0;--line-2:#E2E5E9;--ok-bg:#DDF1EB;--ok:#0A5446;--warn-bg:#FBEBD2;--warn:#7A3E05;--danger-bg:#FBE3E0;--danger:#8C1D17;--info-bg:#E3ECF8;--info:#1D4F91;--alert:#E9A23B;--shadow:rgba(0,0,0,.15);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bar:#0F1E4D;--bar-ctl:#1B2D6B;--bar-line:#35508F;--bar-text:#C9D6F0;--bar-dim:#7E93C4;--primary:#2563EB;--primary-h:#1D4ED8;--accent:#1E3A8A;--accent-line:#2B4CA8;--focus:#60A5FA;--focus-ring:#60A5FA;--line-input:#6B7686;--bg:#12151A;--surface:#1B1F26;--head:#20252E;--hover:#242A34;--tabrow:#1C2743;--tabrow-line:#34467A;--tabrow-text:#AFC0E8;--tabrow-hover:#253357;--text:#E6E9EF;--text-muted:#A4ADBA;--line:#2E3542;--line-2:#262C37;--ok-bg:#0F3A30;--ok:#8EE0C7;--warn-bg:#4A2E0A;--warn:#F5C98A;--danger-bg:#4A1715;--danger:#F5A39E;--info-bg:#1B2E55;--info:#A9C4F5;--alert:#F0B45A;--shadow:rgba(0,0,0,.5);color-scheme:dark}}
:root[data-theme="dark"]{--bar:#0F1E4D;--bar-ctl:#1B2D6B;--bar-line:#35508F;--bar-text:#C9D6F0;--bar-dim:#7E93C4;--primary:#2563EB;--primary-h:#1D4ED8;--accent:#1E3A8A;--accent-line:#2B4CA8;--focus:#60A5FA;--focus-ring:#60A5FA;--line-input:#6B7686;--bg:#12151A;--surface:#1B1F26;--head:#20252E;--hover:#242A34;--tabrow:#1C2743;--tabrow-line:#34467A;--tabrow-text:#AFC0E8;--tabrow-hover:#253357;--text:#E6E9EF;--text-muted:#A4ADBA;--line:#2E3542;--line-2:#262C37;--ok-bg:#0F3A30;--ok:#8EE0C7;--warn-bg:#4A2E0A;--warn:#F5C98A;--danger-bg:#4A1715;--danger:#F5A39E;--info-bg:#1B2E55;--info:#A9C4F5;--alert:#F0B45A;--shadow:rgba(0,0,0,.5);color-scheme:dark}
body{background:var(--bg);color:var(--text);font-size:14px;margin:0}
</style>
<style type="text/tailwindcss">
@theme inline{
  --font-sans:"Source Sans 3","Segoe UI",Arial,sans-serif; --font-mono:"JetBrains Mono",Menlo,monospace;
  --color-bar:var(--bar);--color-bar-ctl:var(--bar-ctl);--color-bar-line:var(--bar-line);--color-bar-text:var(--bar-text);--color-bar-dim:var(--bar-dim);
  --color-primary:var(--primary);--color-primary-h:var(--primary-h);--color-accent:var(--accent);--color-accent-line:var(--accent-line);--color-focus:var(--focus);--color-focus-ring:var(--focus-ring);--color-line-input:var(--line-input);
  --color-page:var(--bg);--color-surface:var(--surface);--color-head:var(--head);--color-hover:var(--hover);
  --color-tabrow:var(--tabrow);--color-tabrow-line:var(--tabrow-line);--color-tabrow-text:var(--tabrow-text);--color-tabrow-hover:var(--tabrow-hover);
  --color-text:var(--text);--color-text-muted:var(--text-muted);--color-line:var(--line);--color-line-2:var(--line-2);
  --color-ok:var(--ok);--color-ok-bg:var(--ok-bg);--color-warn:var(--warn);--color-warn-bg:var(--warn-bg);--color-danger:var(--danger);--color-danger-bg:var(--danger-bg);--color-info:var(--info);--color-info-bg:var(--info-bg);--color-alert:var(--alert);
}
</style>
</head>
<body class="font-sans">
<!-- paste one prototype block here -->
</body>
</html>
```

The harness dark block already carries the owner-gated values (`--primary` #2563EB, `--line-input`, `--focus-ring`) so the prototypes show the proposal. If OD-2 or OD-3 is rejected, delete those values and the prototypes fall back to v5.

New i18n keys proposed in this report (rule 24: `es-419` and `en` get the same keys) are collected in §5.

---

## 2. File-by-file findings

Line numbers are those of HEAD `ad5f6bd`. `components.css`, `DataGrid.tsx` and the record page are being edited in the working tree by another agent: rebase these diffs on that work before applying them.

### 2.1 `packages/ui/src/styles/tokens.css`

**UX Friction Analysis**
- `--focus: #93C5FD` (`tokens.css:9`) is both the focus ring and the brand mark (`TopBar.tsx:68`, avatar `TopBar.tsx:163`). As a ring on white it reaches 1.80:1, which fails WCAG 1.4.11 and 2.4.13 (3:1). Keyboard users on 8-hour shifts lose track of the caret in the grid, forms and dialogs.
- `--ring: var(--focus)` (`tokens.css:52`) carries the same failure into every shadcn primitive.
- Input boundaries use `--line` (`#D7DBE0`, 1.39:1 on white; `#2E3542`, 1.34:1 on the dark surface). An empty field in the 4-column party form is hard to tell from the background, which slows fixation on dense forms.
- Dark `--primary: #3B82F6` (`tokens.css:16`) under white 13 px semibold text is 3.68:1, short of the 4.5:1 that this text size needs (primary buttons, pager `.is-on`, user bubbles). As link text on the dark surface it is 4.49:1.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/styles/tokens.css
+++ b/packages/ui/src/styles/tokens.css
@@ :root {
   --primary: #1D4ED8; --primary-h: #1E40AF; --accent: #DBEAFE; --accent-line: #BFDBFE; --focus: #93C5FD;
+  /* Keyboard focus ring, ≥ 3:1 on surface, head, page and accent (WCAG 1.4.11 / 2.4.13). `--focus` stays the brand blue
+     (logo mark, avatar) and the ring colour on the navy bar, where it reaches 5.74:1. */
+  --focus-ring: #1D4ED8;
+  /* OWNER DECISION OD-3: input boundaries ≥ 3:1 (3.07:1); `--line` keeps dividers and card borders. */
+  --line-input: #8A94A3;
+  /* OWNER DECISION OD-2: link text separate from button fill (same value in light). */
+  --link: #1D4ED8;
@@ @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
-  --primary: #3B82F6; --primary-h: #2563EB; --accent: #1E3A8A; --accent-line: #2B4CA8; --focus: #60A5FA;
+  /* OWNER DECISION OD-2: fill #2563EB gives white text 5.17:1; links move to #60A5FA (6.50:1 on surface). */
+  --primary: #2563EB; --primary-h: #1D4ED8; --accent: #1E3A8A; --accent-line: #2B4CA8; --focus: #60A5FA;
+  --focus-ring: #60A5FA; --line-input: #6B7686; --link: #60A5FA;
@@ :root[data-theme="dark"] {
-  --primary: #3B82F6; --primary-h: #2563EB; --accent: #1E3A8A; --accent-line: #2B4CA8; --focus: #60A5FA;
+  --primary: #2563EB; --primary-h: #1D4ED8; --accent: #1E3A8A; --accent-line: #2B4CA8; --focus: #60A5FA;
+  --focus-ring: #60A5FA; --line-input: #6B7686; --link: #60A5FA;
@@ /* shadcn's semantic variables */
-  --input: var(--line);
-  --ring: var(--focus);
+  --input: var(--line-input);
+  --ring: var(--focus-ring);
```

**Pure Tailwind & SVG Prototype Block**: the swatch strip below shows ring, input boundary and button fill, for checking in both themes.
```html
<div class="flex flex-wrap items-center gap-3 bg-surface p-4">
  <button class="rounded-md bg-primary px-3 py-[7px] text-[13px] font-semibold text-white outline-2 outline-offset-1 outline-focus-ring">Guardar</button>
  <input class="w-48 rounded-md border border-line-input bg-surface px-2.5 py-2 text-[13px] text-text placeholder:text-text-muted" placeholder="Razón social">
  <input class="w-48 rounded-md border border-line-input bg-surface px-2.5 py-2 text-[13px] text-text outline-2 outline-offset-1 outline-focus-ring" value="900373115" aria-label="NIT">
  <a href="#" class="text-[13px] text-[var(--link)] underline">Abrir en una pestaña nueva</a>
  <span class="rounded-[4px] bg-ok-bg px-2 py-0.5 text-xs text-ok">Facturable</span>
</div>
```

### 2.2 `packages/ui/src/styles/globals.css`

**UX Friction Analysis**
- `* { @apply border-border outline-ring/50; }` (`globals.css:94`) halves the ring alpha (1.33:1 light, 2.64:1 dark). Every control without its own `:focus-visible` rule falls back to that faint ring: the filter-row inputs, record tabs, tab-row buttons, module items, the matrix checkboxes and the new record-tab buttons.
- No `prefers-reduced-motion` handling for the typing blink, the toggles or the drop-zone transitions (L6).
- The new tokens are not exposed as utilities (`outline-focus-ring`, `border-line-input`), so `shell/*` cannot use them.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/styles/globals.css
+++ b/packages/ui/src/styles/globals.css
@@ @theme inline {
   --color-focus: var(--focus);
+  --color-focus-ring: var(--focus-ring);
+  --color-line-input: var(--line-input);
+  --color-link: var(--link);
@@ @layer base {
   * {
-    @apply border-border outline-ring/50;
+    @apply border-border outline-ring;
   }
+  /* One visible ring for every focusable thing (≥ 3:1); the navy bar keeps the light ring (5.74:1 on --bar). */
+  :focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
+  [data-bar] :focus-visible { outline-color: var(--focus); }
+  /* The skip link (AppShell) and anything else that jumps the caret to a region. */
+  [tabindex="-1"]:focus { outline: none; }
+  @media (prefers-reduced-motion: reduce) {
+    *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
+  }
   body {
```

**Pure Tailwind & SVG Prototype Block**: focus order check. Tab through it: every stop shows the same ring, light on the bar and dark on the page.
```html
<header data-bar class="flex h-12 items-center gap-2.5 bg-bar px-4 text-bar-text">
  <button class="rounded-md bg-bar-ctl px-2.5 py-1.5 text-[13px] text-white focus-visible:outline-2 focus-visible:outline-focus">Café del Norte S.A.S. ▾</button>
  <button class="border-y-[3px] border-transparent border-b-focus px-[11px] text-[13px] font-semibold text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">Terceros</button>
</header>
<main class="flex gap-2 p-4">
  <button class="rounded-md border border-line bg-surface px-3 py-[7px] text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring">Columnas</button>
  <input class="rounded-[4px] border border-line-input bg-surface px-1.5 py-1 text-xs focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus-ring" placeholder="contiene…">
</main>
```

### 2.3 `packages/ui/src/styles/components.css`

**UX Friction Analysis**
- Rings use `var(--focus)` at 1.80:1. HEAD has this at lines 32, 74, 123, 158 and 312, and the record-tab rules of the working tree repeat it (`button:focus-visible`, `.erp-photos__thumb:focus-visible`, `.erp-extra__free table input:focus`).
- The filter-row inputs have no focus rule (`:63`). The active filter is shown only by tint and a border colour (`:64`), so it is colour-only.
- The grid header wraps (`:50`) and the export status sits in a `max-width` slot that mounts and unmounts (`:53`), which reflows the grid (M3). The footer wraps (`:77`), so the body shrinks when a selection appears (M4).
- There is no sticky identity column (`:59-62`) and no busy indicator that leaves the layout alone. The first load has no skeleton.
- The pager is 26 px (`:81`), even on touch (rule 24).
- The unsorted glyph at 30 % opacity reaches 1.66:1 (`:68`).
- The chat log has no `overflow-anchor` control and no reserved status row (`:237`). Long conversations render every bubble, because nothing uses `content-visibility`.
- Matrices (`:284-290`) set no row height or hit area, and no sticky first column.
- `.erp-home-list` (`:335`) does not style its table, so the recent-records widget renders with browser defaults.
- H10: the `erp-attachments__*`, `erp-contacts__*`, `erp-photos__*`, `erp-extra__*` and `erp-record__status/actions` rules are missing at HEAD. The working tree now adds them; verify them in both themes and commit.

**Proposed Code Diff** (additions only, inside `@layer components`; the selectors match the TSX diffs below)
```diff
--- a/packages/ui/src/styles/components.css
+++ b/packages/ui/src/styles/components.css
@@ buttons
-  .erp-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
+  .erp-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
@@ the grid
-  .erp-export-status { max-width: 420px; }
-  .erp-export-status.is-error { color: var(--danger); font-weight: 600; }
+  /* Always rendered: export progress, "Actualizando…" and the like never reflow the header. */
+  .erp-grid__status { flex: 0 1 240px; min-width: 0; height: 18px; line-height: 18px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
+  .erp-grid__status.is-error { color: var(--danger); font-weight: 600; }
+  .erp-grid__hd .is-reserved { visibility: hidden; }
-  .erp-grid__body { overflow: auto; flex-grow: 1; }
+  .erp-grid__body { position: relative; overflow: auto; flex-grow: 1; overscroll-behavior: contain; }
+  /* 2 px busy line over the header row: transform-only animation, no layout. */
+  .erp-grid__busy { position: sticky; top: 0; left: 0; z-index: 4; height: 2px; margin-bottom: -2px; overflow: hidden; pointer-events: none; }
+  .erp-grid__busy::after { content: ""; position: absolute; inset: 0; width: 40%; background: var(--primary); transform: translateX(-100%); animation: erp-busy 1.1s ease-in-out infinite; will-change: transform; }
+  @keyframes erp-busy { to { transform: translateX(260%); } }
+  .erp-skel { display: block; height: 10px; width: var(--w, 70%); border-radius: 3px; background: var(--line-2); }
-  .erp-grid__filters input, .erp-grid__filters select { width: 100%; min-width: 72px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; font-size: 12px; background: var(--surface); color: var(--text); font-weight: 400; }
-  .erp-grid__filters .is-on { border-color: var(--primary); background: var(--accent); }
+  .erp-grid__filters input, .erp-grid__filters select { width: 100%; min-width: 72px; height: 26px; padding: 0 6px; border: 1px solid var(--line-input); border-radius: 4px; font-size: 12px; background: var(--surface); color: var(--text); font-weight: 400; }
+  .erp-grid__filters input:focus-visible, .erp-grid__filters select:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -1px; }
+  /* Active filter: tint plus a shape cue (left bar) and weight, so it does not rely on colour (WCAG 1.4.1). */
+  .erp-grid__filters .is-on { border-color: var(--primary); background: var(--accent); box-shadow: inset 3px 0 0 var(--primary); font-weight: 600; }
+  .erp-grid__range input[type="date"] { min-width: 118px; }
-  .erp-grid__unsorted { opacity: .3; }
+  .erp-grid__unsorted { opacity: .55; }
-  .erp-row-link:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
+  .erp-row-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
+  .erp-row-link:focus-visible td { background: var(--hover); }
+  /* OWNER DECISION OD-4: sticky selection + identity column (the first shown column). */
+  .erp-grid .erp-grid__check { position: sticky; left: 0; z-index: 1; background: var(--surface); }
+  .erp-grid .erp-grid__id { position: sticky; left: 36px; z-index: 1; background: var(--surface); box-shadow: 1px 0 0 var(--line-2); }
+  .erp-grid th.erp-grid__check, .erp-grid th.erp-grid__id { z-index: 3; background: var(--head); }
+  .erp-row-link:hover td.erp-grid__check, .erp-row-link:hover td.erp-grid__id { background: var(--hover); }
+  .erp-row-link.is-selected td.erp-grid__check, .erp-row-link.is-selected td.erp-grid__id { background: var(--accent); }
+  /* OWNER DECISION OD-5: totals under their columns, pinned to the bottom of the scroll area. */
+  .erp-grid tfoot td { position: sticky; bottom: 0; z-index: 1; height: 32px; background: var(--head); border-top: 1px solid var(--line); border-bottom: 0; font-size: 13px; font-weight: 600; }
-  .erp-grid__ft { display: flex; align-items: center; gap: 16px; padding: 8px 14px; border-top: 1px solid var(--line-2); background: var(--head); font-size: 13px; color: var(--text-muted); flex-wrap: wrap; }
+  .erp-grid__ft { display: flex; align-items: center; gap: 16px; height: 40px; padding: 0 14px; border-top: 1px solid var(--line-2); background: var(--head); font-size: 13px; color: var(--text-muted); flex-wrap: nowrap; overflow-x: auto; white-space: nowrap; }
+  .erp-grid__ft-end { margin-left: auto; display: inline-flex; align-items: center; gap: 16px; }
+  .erp-grid__keys { font-size: 11px; color: var(--text-muted); }
+  @media (pointer: coarse) { .erp-pager button, .erp-pager select { min-width: 44px; height: 44px; } .erp-grid__ft { height: auto; min-height: 52px; } }
+
+  /* live / paused indicator for polling and streaming surfaces: filled dot = live, ring = paused (shape, not colour only) */
+  .erp-live { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px; border-radius: 10px; font-size: 12px; color: var(--text-muted); background: var(--head); border: 1px solid var(--line-2); white-space: nowrap; }
+  .erp-live i { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
+  .erp-live.is-paused i { background: transparent; box-shadow: inset 0 0 0 2px var(--text-muted); }
+  .erp-live.is-error i { background: var(--danger); border-radius: 1px; }
@@ forms
-  .erp-field input:not([type="checkbox"]), .erp-field select, .erp-field textarea { padding: 8px 10px; border: 1px solid var(--line); …
+  .erp-field input:not([type="checkbox"]), .erp-field select, .erp-field textarea { padding: 8px 10px; border: 1px solid var(--line-input); border-radius: 6px; background: var(--surface); font-size: 13px; color: var(--text); min-width: 0; width: 100%; }
-  .erp-field input:focus, .erp-field select:focus { outline: 2px solid var(--focus); outline-offset: 1px; }
+  .erp-field input:focus-visible, .erp-field select:focus-visible, .erp-field textarea:focus-visible, .erp-field input:focus, .erp-field select:focus { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
+  /* Computed values (DV, composed name): readable, selectable and focusable by screen readers, not editable. */
+  .erp-field input[readonly] { background: var(--head); color: var(--text); border-style: dashed; }
+  .erp-errors { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-radius: 6px; background: var(--danger-bg); color: var(--danger); font-size: 13px; }
+  .erp-errors a { color: inherit; text-decoration: underline; }
-  .erp-stepup input { width: 120px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); letter-spacing: 3px; }
+  .erp-stepup input, .erp-confirm__stepup input { width: 136px; height: 36px; padding: 0 8px; border: 1px solid var(--line-input); border-radius: 6px; background: var(--surface); color: var(--text); font-size: 16px; letter-spacing: 6px; text-align: center; }
+  .erp-stepup input:focus-visible, .erp-confirm__stepup input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
@@ assistant
-  .erp-chat__log { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; font-size: 14px; line-height: 1.5; }
+  .erp-chat__log { position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; overflow-anchor: none; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 12px; padding: 16px; font-size: 14px; line-height: 1.5; }
+  /* Off-screen bubbles skip layout and paint; the remembered size keeps the scrollbar steady. */
+  .erp-chat__log > .erp-msg:not(:last-child) { content-visibility: auto; contain-intrinsic-size: auto 72px; }
+  .erp-chat__status { flex: 0 0 18px; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
+  .erp-chat__jump { position: sticky; bottom: 0; align-self: center; z-index: 2; box-shadow: 0 4px 12px var(--shadow); }
+  .erp-chat__input textarea { flex: 1 1 auto; min-width: 0; min-height: 38px; max-height: 132px; resize: none; field-sizing: content; padding: 9px 12px; border: 1px solid var(--line-input); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; font-size: 13px; line-height: 1.4; }
-  .erp-confirm__body dd { margin: 0; text-align: right; color: var(--text); min-width: 0; overflow-wrap: anywhere; }
+  .erp-confirm__body dd { margin: 0; text-align: right; color: var(--text); min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
@@ administration
-  .erp-matrix td, .erp-matrix th { text-align: center; }
+  .erp-matrix td, .erp-matrix th { text-align: center; height: 32px; padding: 0 6px; }
+  .erp-matrix tbody tr:hover td { background: var(--hover); }
+  .erp-matrix .erp-matrix__left { position: sticky; left: 0; z-index: 1; background: var(--surface); box-shadow: 1px 0 0 var(--line); text-align: left; min-width: 260px; }
+  .erp-matrix thead .erp-matrix__left { z-index: 3; background: var(--head); }
+  .erp-matrix tbody tr:hover .erp-matrix__left { background: var(--hover); }
+  .erp-matrix th.erp-matrix__role { writing-mode: horizontal-tb; max-width: 120px; white-space: normal; line-height: 1.2; vertical-align: bottom; padding: 6px; }
+  .erp-matrix__hit { display: grid; place-items: center; width: 100%; height: 32px; cursor: pointer; }
+  .erp-matrix__hit:has(input:disabled) { cursor: not-allowed; }
+  .erp-matrix__hit:has(input:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
+  .erp-matrix td.is-dirty { box-shadow: inset 0 0 0 2px var(--warn); }
+  /* Status and pending changes live in a fixed bar under the matrix: nothing above the table ever moves it. */
+  .erp-admin__bar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 6px 14px; border-top: 1px solid var(--line-2); background: var(--head); border-radius: 0 0 8px 8px; }
+  .erp-admin__bar .erp-dian { padding: 4px 10px; }
-  .erp-bar { height: 8px; border-radius: 4px; background: var(--line-2); overflow: hidden; }
+  .erp-bar { height: 8px; border-radius: 4px; background: var(--line-2); overflow: hidden; }
+  .erp-meter { display: block; width: 100%; height: 22px; overflow: visible; }
@@ home dashboard
-  .erp-wg__hd:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
+  .erp-wg__hd:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
+  .erp-wg__size { opacity: 0; transition: opacity .12s; }
+  .erp-wg[data-resizing="true"] .erp-wg__size, .erp-wg__hd:focus-visible .erp-wg__size, .erp-wg:focus-within .erp-wg__size { opacity: 1; }
+  .erp-wg__asof { font-family: var(--font-jetbrains-mono), "JetBrains Mono", Menlo, monospace; font-size: 11px; color: var(--text-muted); }
+  .erp-home-kpi__trend { display: block; width: 100%; height: 28px; margin-top: 6px; }
+  .erp-home-list table { width: 100%; border-collapse: collapse; }
+  .erp-home-list th { position: sticky; top: 0; height: 32px; padding: 0 12px; text-align: left; font-size: 12px; font-weight: 600; color: var(--text-muted); background: var(--head); border-bottom: 1px solid var(--line); }
+  .erp-home-list td { height: 36px; padding: 0 12px; border-bottom: 1px solid var(--line-2); font-size: 13px; white-space: nowrap; }
+  .erp-home-list td.erp-num { text-align: right; font-family: var(--font-jetbrains-mono), "JetBrains Mono", Menlo, monospace; font-size: 12px; }
@@ record tabs (working tree)
-  :is(.erp-contacts, .erp-photos, .erp-extra, .erp-attachments) button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
+  :is(.erp-contacts, .erp-photos, .erp-extra, .erp-attachments) button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
-  .erp-photos__choose:focus-within, .erp-attachments__choose:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 2px; }
+  /* The chooser is now a real <button> (attachments-panel.tsx diff); this keeps the link look. */
+  :is(.erp-contacts, .erp-photos, .erp-extra, .erp-attachments) button.erp-attachments__choose, .erp-photos button.erp-photos__choose { min-height: 0; padding: 0; border: 0; background: transparent; color: var(--link, var(--primary)); text-decoration: underline; font-weight: 600; }
+  .erp-attachments__drop:focus-within, .erp-photos__drop:focus-within { border-color: var(--focus-ring); }
+  .erp-attachments__state { flex: 0 0 96px; font-size: 12px; color: var(--text-muted); text-align: right; }
+  .erp-attachments__when { font-family: var(--font-jetbrains-mono), "JetBrains Mono", Menlo, monospace; font-size: 11px; }
+  @media (prefers-reduced-motion: reduce) { .erp-typing i, .erp-grid__busy::after { animation: none; } .erp-toggle, .erp-toggle::after, .erp-drop { transition: none; } }
```

**Pure Tailwind & SVG Prototype Block**: the live and paused indicator and the busy line, the two stream primitives this report reuses.
```html
<div class="flex flex-col gap-3 bg-surface p-4">
  <div class="flex items-center gap-2">
    <span class="inline-flex h-5 items-center gap-1.5 rounded-full border border-line-2 bg-head px-2 text-xs text-text-muted" role="status"><i class="size-2 rounded-full bg-ok"></i>En vivo · <span class="font-mono tabular-nums">10:42:07</span></span>
    <span class="inline-flex h-5 items-center gap-1.5 rounded-full border border-line-2 bg-head px-2 text-xs text-text-muted" role="status"><i class="size-2 rounded-full shadow-[inset_0_0_0_2px_var(--text-muted)]"></i>En pausa · pestaña oculta</span>
    <span class="inline-flex h-5 items-center gap-1.5 rounded-full border border-line-2 bg-head px-2 text-xs text-text-muted" role="status"><i class="size-2 rounded-[1px] bg-danger"></i>Sin conexión · <button class="text-xs text-primary underline">Reanudar</button></span>
  </div>
  <div class="relative h-24 overflow-hidden rounded-lg border border-line">
    <div class="sticky top-0 z-10 -mb-0.5 h-0.5 overflow-hidden"><div class="h-full w-2/5 animate-pulse bg-primary"></div></div>
    <div class="flex h-9 items-center border-b border-line bg-head px-3 text-xs font-semibold text-text-muted">Razón social</div>
    <div class="flex h-9 items-center border-b border-line-2 px-3 text-sm">Almacenes Éxito S.A.</div>
  </div>
</div>
```

### 2.4 `packages/ui/src/shell/AppShell.tsx`

**UX Friction Analysis**
- There is no skip-to-content link. A keyboard user crosses the brand, company, Módulos, every module item, ⌘K, theme, notifications, Asistente, avatar, every tab, "+" and "Cerrar todas" (15 to 25 stops) before reaching the grid on every screen change (`AppShell.tsx:191-213`).
- `<main>` has no id and no `tabIndex=-1`, so nothing can send focus there after a tab change. Focus stays on the clicked tab and the screen reader announces nothing.
- The assistant opens by default (`:159`). On a 1366 px laptop the 400 px drawer leaves `<main>` 966 − 48 = 918 px. The party grid header (title, switches, 8 buttons) then wraps to two lines, and the 4-column party form is cramped (owner decision OD-10 for a viewport-based default).
- There is no keyboard toggle for the drawer, and the composer cannot be reached without the mouse or about 20 Tabs.
- `px-6 py-5 gap-4` on `<main>` (`:211`) equals the prototype's `main { padding: 20px 24px; gap: 16px }`, so it is contract. On grid routes, 40 px of vertical padding costs one 36 px row per screen (OD-1).

**Proposed Code Diff**
```diff
--- a/packages/ui/src/shell/AppShell.tsx
+++ b/packages/ui/src/shell/AppShell.tsx
@@
   const [paletteOpen, setPaletteOpen] = useState(false);
   const [assistantOpen, setAssistantOpen] = useState(true);
+  // OWNER DECISION OD-10: below 1280 px the drawer starts closed (after mount, so the server render and hydration agree).
+  useEffect(() => {
+    if (!window.matchMedia("(min-width: 1280px)").matches) setAssistantOpen(false);
+  }, []);
+  const openRef = useRef(assistantOpen);
+  const focusComposer = useRef(false);
+  useEffect(() => {
+    openRef.current = assistantOpen;
+    if (assistantOpen && focusComposer.current) document.getElementById("erp-assistant-input")?.focus();
+    focusComposer.current = false;
+  }, [assistantOpen]);
+  // ⌘/ (Ctrl+/ elsewhere) shows the assistant with the cursor in its input, or hides it and returns the caret to the page.
+  useEffect(() => {
+    const onKey = (event: KeyboardEvent) => {
+      if (!(event.metaKey || event.ctrlKey) || event.key !== "/") return;
+      event.preventDefault();
+      if (openRef.current) document.getElementById("erp-main")?.focus();
+      else focusComposer.current = true;
+      setAssistantOpen(!openRef.current);
+    };
+    document.addEventListener("keydown", onKey);
+    return () => document.removeEventListener("keydown", onKey);
+  }, []);
@@
+  // A tab change lands the caret on the page (not on the tab button), so the next Tab or arrow works on the screen itself.
+  useEffect(() => {
+    if (document.activeElement?.closest("[data-tabs-row]")) document.getElementById("erp-main")?.focus({ preventScroll: true });
+  }, [currentHref]);
@@
         <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-page text-text">
+          <a
+            href="#erp-main"
+            className="sr-only rounded-md bg-surface px-3 py-2 text-[13px] font-semibold text-primary focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:shadow-[0_10px_30px_var(--shadow)]"
+          >
+            {t("nav.shell.skip_to_content")}
+          </a>
           <TopBar
@@
             onOpenPalette={() => setPaletteOpen(true)}
+            assistantOpen={assistantOpen}
             onToggleAssistant={() => setAssistantOpen((open) => !open)}
@@
           <div className="flex min-h-0 flex-1">
-            <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto px-6 py-5">
+            {/* OWNER DECISION OD-1: grid and admin routes may use "gap-3 px-4 py-3" (+1 row per screen); v5 keeps 20/24/16. */}
+            <main id="erp-main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto px-6 py-5 [scrollbar-gutter:stable]">
```

**Pure Tailwind & SVG Prototype Block**: the shell at full density with skip link, 48 px bar, 36 px tabs row, page and 400 px drawer.
```html
<div class="flex h-[560px] min-h-0 flex-col overflow-hidden bg-page text-text">
  <a href="#p-main" class="sr-only rounded-md bg-surface px-3 py-2 text-[13px] font-semibold text-primary focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50">Saltar al contenido</a>
  <header data-bar class="relative z-10 flex h-12 shrink-0 items-center gap-2.5 bg-bar px-4 text-bar-text">
    <div class="mr-1.5 flex items-center gap-2 text-[15px] font-bold text-white"><i class="inline-block size-[22px] rounded-md bg-focus"></i>ERP-IA</div>
    <button class="rounded-md bg-bar-ctl px-2.5 py-1.5 text-[13px] text-white">Café del Norte S.A.S. ▾</button>
    <button class="rounded-md border border-bar-line px-2.5 py-1.5 text-[13px]">Base ▾</button>
    <nav class="ml-1.5 flex items-stretch gap-0.5 self-stretch border-l border-bar-line pl-2.5 text-[13px]">
      <button class="border-y-[3px] border-transparent px-[11px] hover:bg-bar-ctl">Inicio</button>
      <button aria-current="page" class="border-y-[3px] border-transparent border-b-focus px-[11px] font-semibold text-white">Terceros</button>
      <button class="border-y-[3px] border-transparent px-[11px] hover:bg-bar-ctl">Productos</button>
    </nav>
    <div class="grow"></div>
    <input readonly class="w-[200px] rounded-md border border-bar-line bg-bar-ctl px-3 py-[7px] text-[13px] text-white placeholder:text-bar-text" placeholder="⌘K  Buscar, crear o preguntar">
    <button aria-expanded="true" aria-controls="p-assistant" aria-keyshortcuts="Control+/ Meta+/" class="rounded-md bg-white px-2.5 py-1.5 text-[13px] font-semibold text-bar">Asistente</button>
  </header>
  <nav data-tabs-row class="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-tabrow-line bg-tabrow px-3 [scrollbar-width:none]">
    <div class="mt-[5px] flex items-center rounded-t-md px-3.5 text-[13px] whitespace-nowrap text-tabrow-text">Inicio</div>
    <div class="mt-[5px] flex items-center gap-1.5 rounded-t-md border border-b-0 border-tabrow-line bg-page px-3.5 text-[13px] font-semibold whitespace-nowrap">Terceros<button class="grid size-5 place-items-center rounded-sm text-xs opacity-60 hover:bg-tabrow-hover hover:opacity-100" aria-label="Cerrar Terceros">✕</button></div>
  </nav>
  <div class="flex min-h-0 flex-1">
    <main id="p-main" tabindex="-1" class="flex min-w-0 flex-1 flex-col gap-4 overflow-auto px-6 py-5 outline-none [scrollbar-gutter:stable]">
      <section class="flex h-full flex-col rounded-lg border border-line bg-surface"><div class="flex h-[49px] items-center border-b border-line-2 px-3.5 font-bold">Terceros</div></section>
    </main>
    <aside id="p-assistant" class="flex w-[400px] shrink-0 flex-col border-l border-line bg-surface"><div class="flex h-[45px] items-center border-b border-line-2 px-4 font-bold">Asistente</div></aside>
  </div>
</div>
```

### 2.5 `packages/ui/src/shell/TopBar.tsx`

**UX Friction Analysis**
- The Asistente button (`:156-158`) has no `aria-expanded`/`aria-controls`. A screen-reader user cannot tell whether the drawer is open, and sighted users see no hint of a shortcut.
- The notification dot (`:146`) is drawn even when the list is empty (`:150-152`). It is a permanent, colour-only alarm, and users learn to ignore it before phase 2 makes it real (L1).
- The ⌘K box is a `readOnly` input (`:126-136`). That works, but screen readers call it an "edit text" that cannot be edited. A `button` with the same look would be honest. This is optional and not in the diff.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/shell/TopBar.tsx
+++ b/packages/ui/src/shell/TopBar.tsx
@@ export interface TopBarProps {
   onOpenPalette: () => void;
+  /** The assistant drawer is showing (the toggle's pressed state). */
+  assistantOpen?: boolean;
+  /** Unread notifications; the dot shows only above zero. */
+  notificationCount?: number;
   onToggleAssistant: () => void;
@@
-    <header className="relative z-10 flex h-12 shrink-0 items-center gap-2.5 bg-bar px-4 text-bar-text">
+    <header data-bar className="relative z-10 flex h-12 shrink-0 items-center gap-2.5 bg-bar px-4 text-bar-text">
@@
-          <Bell aria-hidden="true" className="size-[18px]" />
-          <span aria-hidden="true" className="absolute top-[5px] right-[5px] size-2 rounded-full bg-alert" />
+          <Bell aria-hidden="true" className="size-[18px]" />
+          {(props.notificationCount ?? 0) > 0 && (
+            <span className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-alert px-1 text-[10px] font-bold text-bar tabular-nums">
+              {props.notificationCount! > 9 ? "9+" : props.notificationCount}
+            </span>
+          )}
@@
-      <button type="button" onClick={props.onToggleAssistant} className={cn(barButton, "bg-white font-semibold text-bar")}>
+      <button
+        type="button"
+        onClick={props.onToggleAssistant}
+        aria-expanded={props.assistantOpen ?? true}
+        aria-controls="erp-assistant"
+        aria-keyshortcuts="Control+/ Meta+/"
+        title={s("assistant_toggle_title")}
+        className={cn(barButton, props.assistantOpen === false ? "border border-bar-line bg-transparent text-bar-text" : "bg-white font-semibold text-bar")}
+      >
         {s("assistant")}
       </button>
```

**Pure Tailwind & SVG Prototype Block**
```html
<header data-bar class="flex h-12 items-center gap-2.5 bg-bar px-4 text-bar-text">
  <div class="grow"></div>
  <button class="relative grid size-[34px] place-items-center rounded-md border border-bar-line" aria-label="Notificaciones, 3 sin leer">
    <svg viewBox="0 0 24 24" class="size-[18px]" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
    <span class="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-alert px-1 text-[10px] font-bold text-bar tabular-nums">3</span>
  </button>
  <button aria-expanded="true" title="Mostrar u ocultar el asistente (Ctrl+/)" class="rounded-md bg-white px-2.5 py-1.5 text-[13px] font-semibold text-bar">Asistente</button>
  <button aria-expanded="false" class="rounded-md border border-bar-line px-2.5 py-1.5 text-[13px] text-bar-text">Asistente</button>
</header>
```

### 2.6 `packages/ui/src/shell/ModuleBar.tsx`

**UX Friction Analysis**
- The module items (`:33-44`) have no focus style. On the navy bar the inherited ring is `--focus` at 50 % alpha (2.61:1), so the keyboard caret is hard to find in the primary navigation.
- The active item is shown by a 3 px light underline plus bold (`:40`): shape and weight, so this is fine.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/shell/ModuleBar.tsx
+++ b/packages/ui/src/shell/ModuleBar.tsx
@@
             className={cn(
-              "border-y-[3px] border-transparent bg-transparent px-[11px] text-[13px] whitespace-nowrap text-bar-text hover:bg-bar-ctl hover:text-white",
+              "border-y-[3px] border-transparent bg-transparent px-[11px] text-[13px] whitespace-nowrap text-bar-text hover:bg-bar-ctl hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
               on && "border-b-focus font-semibold text-white",
             )}
```

**Pure Tailwind & SVG Prototype Block**
```html
<nav data-bar class="flex h-12 items-stretch gap-0.5 bg-bar px-3 text-[13px] text-bar-text">
  <button class="border-y-[3px] border-transparent px-[11px] hover:bg-bar-ctl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">Inicio</button>
  <button aria-current="page" class="border-y-[3px] border-transparent border-b-focus px-[11px] font-semibold text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">Terceros</button>
  <button class="border-y-[3px] border-transparent px-[11px] outline-2 -outline-offset-2 outline-focus">Productos (foco)</button>
</nav>
```

### 2.7 `packages/ui/src/shell/TabsBar.tsx`

**UX Friction Analysis**
- `overflow-hidden` (`:41`) clips tabs past the right edge. With the drawer open, about 7 to 9 tabs fit, and a back-office user easily has more open. Clipped tabs cannot be reached by mouse or keyboard, and the active one may be among them (H9).
- The tab button focus is `outline-none focus-visible:underline` (`:61`): an underline under 13 px text is a weak focus cue next to the underline-less design.
- The close ✕ (`:66-73`) is a glyph about 12 px wide at 50 % opacity: slow to hit and easy to miss (L5).
- No arrow-key movement between tabs. Each tab is two separate tab stops (title and close).

**Proposed Code Diff**
```diff
--- a/packages/ui/src/shell/TabsBar.tsx
+++ b/packages/ui/src/shell/TabsBar.tsx
@@
-import { useState } from "react";
+import { useEffect, useRef, useState, type KeyboardEvent } from "react";
@@
   const closable = tabs.filter((tab) => !tab.pinned);
+  const row = useRef<HTMLElement>(null);
+  // OWNER DECISION OD-6: the row scrolls instead of clipping (v5 `.tabrow { overflow: hidden }`); the active tab is kept in view.
+  useEffect(() => {
+    row.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(activeId ?? "")}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
+  }, [activeId, tabs.length]);
+  // ← → move between tab titles (one stop per tab in the arrow order); Delete closes the focused tab.
+  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
+    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
+    if (step !== 0) {
+      event.preventDefault();
+      const next = tabs[(index + step + tabs.length) % tabs.length];
+      row.current?.querySelector<HTMLButtonElement>(`[data-tab="${CSS.escape(next!.id)}"] > button`)?.focus();
+    } else if (event.key === "Delete" && !tabs[index]!.pinned) {
+      event.preventDefault();
+      close(tabs[index]!.id);
+    }
+  };
@@
     <nav
+      ref={row}
+      data-tabs-row
       aria-label={t("tabs.label")}
-      className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-hidden border-b border-tabrow-line bg-tabrow px-3"
+      className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-tabrow-line bg-tabrow px-3 [scrollbar-width:none]"
     >
-      {tabs.map((tab) => {
+      {tabs.map((tab, index) => {
@@
             <button
               type="button"
               aria-current={on ? "page" : undefined}
+              tabIndex={on ? 0 : -1}
+              onKeyDown={(event) => onTabKey(event, index)}
               onClick={() => {
                 activate(tab.id);
                 onActivate?.(tab);
               }}
-              className="h-full bg-transparent outline-none focus-visible:underline"
+              className="h-full rounded-sm bg-transparent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
             >
@@
               <button
                 type="button"
                 aria-label={t("tabs.close", { title: titleOf(tab) })}
+                tabIndex={-1}
                 onClick={() => close(tab.id)}
-                className="text-xs opacity-50 hover:opacity-100 focus-visible:opacity-100"
+                className="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60 hover:bg-tabrow-hover hover:opacity-100"
               >
@@
       <button
         type="button"
         aria-label={t("tabs.new")}
         onClick={onNew}
-        className="mt-[5px] flex items-center rounded-t-md px-3.5 text-base text-tabrow-text hover:bg-tabrow-hover"
+        className="sticky right-0 mt-[5px] flex shrink-0 items-center rounded-t-md bg-tabrow px-3.5 text-base text-tabrow-text hover:bg-tabrow-hover"
       >
```
(The ✕ stays clickable with the mouse; from the keyboard, Delete closes the focused tab, so the row has one stop per tab list instead of two per tab.)

**Pure Tailwind & SVG Prototype Block**: 14 tabs in a 720 px row that scrolls, with the active tab kept in view.
```html
<nav data-tabs-row class="flex h-9 w-[720px] items-stretch gap-0.5 overflow-x-auto overflow-y-hidden border-b border-tabrow-line bg-tabrow px-3 [scrollbar-width:none]">
  <div class="mt-[5px] flex shrink-0 items-center rounded-t-md px-3.5 text-[13px] text-tabrow-text">Inicio</div>
  <div class="mt-[5px] flex shrink-0 items-center gap-1.5 rounded-t-md px-3.5 text-[13px] text-tabrow-text">Terceros<button tabindex="-1" class="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60 hover:bg-tabrow-hover">✕</button></div>
  <div class="mt-[5px] flex shrink-0 items-center gap-1.5 rounded-t-md px-3.5 text-[13px] text-tabrow-text">Productos<button tabindex="-1" class="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60 hover:bg-tabrow-hover">✕</button></div>
  <div class="mt-[5px] flex shrink-0 items-center gap-1.5 rounded-t-md px-3.5 text-[13px] text-tabrow-text">Almacenes Éxito S.A.<button tabindex="-1" class="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60">✕</button></div>
  <div class="mt-[5px] flex shrink-0 items-center gap-1.5 rounded-t-md px-3.5 text-[13px] text-tabrow-text">Categorías<button tabindex="-1" class="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60">✕</button></div>
  <div class="mt-[5px] flex shrink-0 items-center gap-1.5 rounded-t-md px-3.5 text-[13px] text-tabrow-text">Importar datos<button tabindex="-1" class="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60">✕</button></div>
  <div class="mt-[5px] flex shrink-0 items-center gap-1.5 rounded-t-md px-3.5 text-[13px] text-tabrow-text">Permisos<button tabindex="-1" class="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60">✕</button></div>
  <div class="mt-[5px] flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 border-tabrow-line bg-page px-3.5 text-[13px] font-semibold text-text"><button class="rounded-sm outline-2 -outline-offset-2 outline-focus-ring">Café Molido 500 g</button><button tabindex="-1" class="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60">✕</button></div>
  <div class="mt-[5px] flex shrink-0 items-center gap-1.5 rounded-t-md px-3.5 text-[13px] text-tabrow-text">Uso de IA<button tabindex="-1" class="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60">✕</button></div>
  <button class="sticky right-0 mt-[5px] flex shrink-0 items-center rounded-t-md bg-tabrow px-3.5 text-base text-tabrow-text">+</button>
</nav>
```

### 2.8 `apps/web/src/app/(app)/layout.tsx` and the route pages (`page.tsx` of `/`, `/r/[entity]/[id]`, `/import`, the grid routes)

**UX Friction Analysis**
- Every level renders `<Suspense fallback={null}>` (`(app)/layout.tsx:33`, `page.tsx:29`, `r/[entity]/[id]/page.tsx:139`, `import/page.tsx:26`) and no route has a `loading.tsx`. The shell, then the page, appear from a blank screen: the whole layout shifts after each navigation, and the user cannot tell "loading" from "empty".
- After a tab change the old page stays until the new server render arrives, with no sign that anything is happening.

**Proposed Code Diff**: new `loading.tsx` files sized to the final layout (no Spanish literals: the label comes from `common.loading`).
```tsx
// apps/web/src/app/(app)/loading.tsx  (new) — the page skeleton inside the shell: same paddings, a 49 px header, 36 px rows.
import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations("common");
  return (
    <section className="erp-grid" aria-busy="true" aria-label={t("loading")}>
      <div className="erp-grid__hd">
        <span className="erp-skel" style={{ ["--w" as string]: "140px", height: 16 }} />
      </div>
      <div className="erp-grid__body">
        <table>
          <tbody>
            {Array.from({ length: 12 }, (_, i) => (
              <tr key={i}>
                <td className="erp-grid__check" />
                <td><span className="erp-skel" style={{ ["--w" as string]: `${50 + ((i * 37) % 40)}%` }} /></td>
                <td><span className="erp-skel" style={{ ["--w" as string]: "60%" }} /></td>
                <td className="text-right"><span className="erp-skel ml-auto" style={{ ["--w" as string]: "80px" }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```
```diff
--- a/apps/web/src/app/(app)/layout.tsx
+++ b/apps/web/src/app/(app)/layout.tsx
@@
-    <Suspense fallback={null}>
+    {/* The shell's frame (48 px bar, 36 px tabs row) is drawn at once; the page skeleton fills the rest. */}
+    <Suspense fallback={<div className="flex h-dvh flex-col bg-page"><div className="h-12 shrink-0 bg-bar" /><div className="h-9 shrink-0 border-b border-tabrow-line bg-tabrow" /></div>}>
       <ShellView>{children}</ShellView>
     </Suspense>
```
Each route page's own `Suspense fallback={null}` can then go: the segment's `loading.tsx` covers it.

**Pure Tailwind & SVG Prototype Block**: the skeleton has the final dimensions, so rows replace bars in place with no shift.
```html
<section class="flex h-[420px] flex-col overflow-hidden rounded-lg border border-line bg-surface" aria-busy="true" aria-label="Cargando…">
  <div class="flex h-[49px] items-center gap-2 border-b border-line-2 px-3.5"><span class="block h-4 w-36 rounded-[3px] bg-line-2"></span><span class="ml-auto block h-[30px] w-24 rounded-md bg-line-2"></span><span class="block h-[30px] w-20 rounded-md bg-line-2"></span></div>
  <div class="flex h-9 items-center gap-6 border-b border-line bg-head px-3"><span class="block h-2.5 w-24 rounded-[3px] bg-line"></span><span class="block h-2.5 w-20 rounded-[3px] bg-line"></span><span class="ml-auto block h-2.5 w-16 rounded-[3px] bg-line"></span></div>
  <div class="flex h-9 items-center gap-6 border-b border-line-2 px-3"><span class="block h-2.5 w-56 rounded-[3px] bg-line-2"></span><span class="block h-2.5 w-24 rounded-[3px] bg-line-2"></span><span class="ml-auto block h-2.5 w-20 rounded-[3px] bg-line-2"></span></div>
  <div class="flex h-9 items-center gap-6 border-b border-line-2 px-3"><span class="block h-2.5 w-44 rounded-[3px] bg-line-2"></span><span class="block h-2.5 w-28 rounded-[3px] bg-line-2"></span><span class="ml-auto block h-2.5 w-24 rounded-[3px] bg-line-2"></span></div>
  <div class="flex h-9 items-center gap-6 border-b border-line-2 px-3"><span class="block h-2.5 w-64 rounded-[3px] bg-line-2"></span><span class="block h-2.5 w-20 rounded-[3px] bg-line-2"></span><span class="ml-auto block h-2.5 w-16 rounded-[3px] bg-line-2"></span></div>
  <div class="mt-auto flex h-10 items-center border-t border-line-2 bg-head px-3 text-[13px] text-text-muted">Cargando…</div>
</section>
```

### 2.9 `packages/ui/src/grid/DataGrid.tsx` (being edited concurrently: rebase)

**UX Friction Analysis**
- **Tab trap (H2).** Each `<tr>` has `tabIndex=0` (`:246`) and holds a tabbable checkbox (`:253`). At 50 rows a page that is 100 stops between the filter row and the pager, and nothing moves with arrow keys. Keyboard work (arrows, Space, Enter, the habit from Siigo, Excel and desktop ERPs) is impossible. Rule 20's "row selection" can only be done with a mouse at speed.
- **No way back to the filters.** From the rows there is no key to return to the filter row, and no `/` to search.
- **First-load lie (M2).** `total = data.page?.total ?? 0` (`:101`) shows "0 registros" in the header (`:153`) and "0–0 de 0" in the footer while the first request is in flight. The body is empty, so it is not even the "Sin registros" row (`:260`). The rows then jump in.
- **Header reflow (M3).** `ExportStatusText` returns `null` when idle (`:36`) and the "Limpiar filtros" button mounts only when `dirty` (`:180-184`). In a `flex-wrap` header, both push the export buttons onto a second line and the whole grid moves down 40 px while the user aims at a row.
- **Refetch is invisible.** Only `aria-busy` (`:149`) marks a refetch. Sighted users get no cue that the rows under their pointer are about to change.
- **Wide grids lose identity (M5).** Neither the selection column nor the first data column is sticky.
- **Export ready status stays forever (L10).** It is never dismissed.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/grid/DataGrid.tsx
+++ b/packages/ui/src/grid/DataGrid.tsx
@@
-import { useMemo, useState, type ReactNode } from "react";
+import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
 import { useTranslations } from "next-intl";
 import { Search } from "lucide-react";
+import { cn } from "@erp/ui/lib/utils";
+import { formatMoney } from "../money/format";
@@
-import { initialView, moneyColumns, selectionTotals, shownColumns, stateFilters } from "./grid-model";
+import { initialView, moneyColumns, pageCount, selectionTotals, shownColumns, stateFilters } from "./grid-model";
@@
-/** How the running export is going, for screen readers and eyes alike (role="status"). */
-function ExportStatusText({ status }: { status: ReturnType<typeof useGridExport>["status"] }) {
+/** One fixed slot for what the grid is doing (export, refetch): always rendered, so the header never reflows. */
+function GridStatusText({ status, refreshing }: { status: ReturnType<typeof useGridExport>["status"]; refreshing: boolean }) {
   const t = useTranslations();
-  if (status.phase === "idle") return null;
   const text =
-    status.phase === "working"
+    status.phase === "idle"
+      ? refreshing
+        ? t("grid.refreshing")
+        : ""
+      : status.phase === "working"
       ? t("grid.export.working", { format: t(`grid.export.${FORMAT_LABEL[status.format]}`) })
@@
   return (
-    <span role="status" className={status.phase === "failed" ? "erp-small erp-export-status is-error" : "erp-small erp-muted erp-export-status"}>
+    <span role="status" title={text || undefined} className={status.phase === "failed" ? "erp-small erp-grid__status is-error" : "erp-small erp-muted erp-grid__status"}>
       {text}
     </span>
   );
 }
@@
   const [selected, setSelected] = useState<Set<string>>(new Set());
+  // Roving tabindex: one row is the grid's single tab stop; arrows move it (WAI-ARIA grid row pattern).
+  const [activeRow, setActiveRow] = useState(0);
+  const sectionRef = useRef<HTMLElement>(null);
+  const bodyRef = useRef<HTMLTableSectionElement>(null);
   const [rowsSeen, setRowsSeen] = useState(rows);
   if (rowsSeen !== rows) {
     // A new page of rows starts with nothing selected.
     setRowsSeen(rows);
     setSelected(new Set());
+    setActiveRow(0);
   }
@@
+  const firstFilter = () => sectionRef.current?.querySelector<HTMLElement>(".erp-grid__filters :is(input, select):not(:disabled)");
+  const focusRow = (index: number) => {
+    const next = Math.max(0, Math.min(rows.length - 1, index));
+    setActiveRow(next);
+    bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]")[next]?.focus();
+  };
+  const pages = pageCount(total, view.pageSize);
+  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: GridRow) => {
+    if (event.target !== event.currentTarget) return;
+    const keys: Record<string, () => void> = {
+      ArrowDown: () => focusRow(index + 1),
+      ArrowUp: () => (index === 0 ? firstFilter()?.focus() : focusRow(index - 1)),
+      Home: () => focusRow(0),
+      End: () => focusRow(rows.length - 1),
+      PageDown: () => view.page < pages && grid.setPage(view.page + 1),
+      PageUp: () => view.page > 1 && grid.setPage(view.page - 1),
+      " ": () => toggleRow(row.id),
+      Enter: () => onRowOpen?.(row),
+    };
+    const run = keys[event.key];
+    if (!run) return;
+    event.preventDefault();
+    run();
+  };
+  // "/" from anywhere in the grid (outside a text box) goes to the first filter, as in mail and issue trackers.
+  const onGridKey = (event: KeyboardEvent<HTMLElement>) => {
+    const typing = (event.target as HTMLElement).closest("input, select, textarea, [contenteditable]");
+    if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
+      event.preventDefault();
+      firstFilter()?.focus();
+    }
+  };
+  const firstLoad = data.page === null && data.loading;
@@
-    <section className="erp-grid" aria-label={title} aria-busy={data.loading}>
+    <section ref={sectionRef} className="erp-grid" aria-label={title} aria-busy={data.loading} onKeyDown={onGridKey}>
       <div className="erp-grid__hd">
         <h2>{title}</h2>
         <span className="erp-small erp-muted">
-          {t("grid.count", { count: total })}
+          {data.page ? t("grid.count", { count: total }) : t("grid.loading")}
@@
         <ExportButtons onExport={(format) => (onExport ? onExport(format, exportState()) : void exporter.run(format, exportState()))} busy={exporter.busy} />
-        <ExportStatusText status={exporter.status} />
-        {dirty && (
-          <button type="button" className="erp-btn erp-btn--ghost" onClick={grid.clear}>
-            {t("grid.clear_filters")}
-          </button>
-        )}
+        <GridStatusText status={exporter.status} refreshing={data.loading && data.page !== null} />
+        {/* Always laid out; hidden (not removed) while there is nothing to clear, so nothing to its left moves. */}
+        <button type="button" className={cn("erp-btn erp-btn--ghost", !dirty && "is-reserved")} onClick={grid.clear} disabled={!dirty} aria-hidden={!dirty} tabIndex={dirty ? 0 : -1}>
+          {t("grid.clear_filters")}
+        </button>
       </div>
@@
       <div className="erp-grid__body">
+        {data.loading && <div className="erp-grid__busy" aria-hidden="true" />}
         <table>
           <thead>
             <tr>
@@
-              {shown.map((column) => {
+              {shown.map((column, i) => {
@@
                   <th
                     key={column.field}
-                    className={isNumeric(column) ? "text-right" : undefined}
+                    className={cn(isNumeric(column) && "text-right", i === 0 && "erp-grid__id")}
                     aria-sort={sort ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                   >
@@
-            <FilterRow columns={shown} values={view.columnFilters} onChange={grid.setColumnFilter} selectable />
+            <FilterRow columns={shown} values={view.columnFilters} onChange={grid.setColumnFilter} selectable stickyFirst onLeaveDown={() => focusRow(activeRow)} />
           </thead>
-          <tbody>
-            {rows.map((row) => (
+          <tbody ref={bodyRef}>
+            {firstLoad &&
+              Array.from({ length: Math.min(view.pageSize, 12) }, (_, i) => (
+                <tr key={`skel-${i}`} aria-hidden="true">
+                  <td className="erp-grid__check" />
+                  {shown.map((column, c) => (
+                    <td key={column.field} className={cn(isNumeric(column) && "text-right", c === 0 && "erp-grid__id")}>
+                      <span className={cn("erp-skel", isNumeric(column) && "ml-auto")} style={{ ["--w" as string]: isNumeric(column) ? "72px" : `${45 + ((i * 7 + c * 13) % 40)}%` }} />
+                    </td>
+                  ))}
+                </tr>
+              ))}
+            {rows.map((row, index) => (
               <tr
                 key={row.id}
+                data-row
                 className={selected.has(row.id) ? "erp-row-link is-selected" : "erp-row-link"}
-                tabIndex={onRowOpen ? 0 : undefined}
+                tabIndex={index === Math.min(activeRow, rows.length - 1) ? 0 : -1}
+                aria-selected={selected.has(row.id)}
+                onFocus={() => setActiveRow(index)}
                 onClick={() => onRowOpen?.(row)}
-                onKeyDown={(e) => {
-                  if (e.key === "Enter" && e.target === e.currentTarget) onRowOpen?.(row);
-                }}
+                onKeyDown={(e) => onRowKey(e, index, row)}
               >
                 <td className="erp-grid__check" onClick={(e) => e.stopPropagation()}>
-                  <input type="checkbox" aria-label={t("grid.select_row")} checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} />
+                  <input type="checkbox" tabIndex={-1} aria-label={t("grid.select_row")} checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} />
                 </td>
-                {shown.map((column) => (
-                  <GridCell key={column.field} column={column} row={row} />
+                {shown.map((column, i) => (
+                  <GridCell key={column.field} column={column} row={row} className={i === 0 ? "erp-grid__id" : undefined} />
                 ))}
               </tr>
             ))}
@@
           </tbody>
+          {/* OWNER DECISION OD-5: the filter's money totals under their own columns (v5 writes them in the footer text). */}
+          {sums.length > 0 && rows.length > 0 && (
+            <tfoot>
+              <tr>
+                <td className="erp-grid__check" />
+                {shown.map((column, i) => {
+                  const sum = sums.find((s) => s.column.field === column.field);
+                  return (
+                    <td key={column.field} className={cn(i === 0 && "erp-grid__id", sum && "erp-num text-right")}>
+                      {i === 0 ? t("grid.totals_filtered") : sum ? formatMoney(sum.sum as number | string) || formatMoney(0) : null}
+                    </td>
+                  );
+                })}
+              </tr>
+            </tfoot>
+          )}
         </table>
       </div>
       <GridFooter
         page={view.page}
         pageSize={view.pageSize}
         total={total}
+        loading={firstLoad}
         onPage={grid.setPage}
```
`GridCell` takes one more optional prop (`className`, merged into its `cn(base, …)`). The e2e specs that read the footer's "Suma del filtro" text must move to the `tfoot` cell if OD-5 is accepted.

**Pure Tailwind & SVG Prototype Block**: grid at 36 px rows with sticky header, filter row, identity column and totals; the focused row carries the ring and roving tabindex.
```html
<section class="flex h-[460px] flex-col overflow-hidden rounded-lg border border-line bg-surface text-sm" aria-label="Terceros">
  <div class="flex min-h-[49px] flex-wrap items-center gap-2 border-b border-line-2 px-3.5 py-2.5">
    <h2 class="m-0 text-base font-bold">Terceros</h2><span class="text-xs text-text-muted">482 registros · 1 enmascarado</span>
    <div class="grow"></div>
    <button class="rounded-md bg-primary px-3 py-[7px] text-[13px] font-semibold text-white">Nuevo</button>
    <button class="rounded-md border border-line px-3 py-[7px] text-[13px]">Columnas</button>
    <button class="rounded-md border border-line px-3 py-[7px] text-[13px]">Filtro avanzado</button>
    <span class="inline-flex gap-2"><button class="rounded-md border border-line px-3 py-[7px] text-[13px]"><span class="text-[#D93025]">■</span> PDF</button><button class="rounded-md border border-line px-3 py-[7px] text-[13px]"><span class="text-[#1E8E3E]">■</span> Excel</button><button class="rounded-md border border-line px-3 py-[7px] text-[13px]"><span class="text-[#5F6B7A]">■</span> CSV</button></span>
    <span role="status" class="h-[18px] w-[240px] truncate text-xs leading-[18px] text-text-muted">Actualizando…</span>
    <button class="invisible rounded-md px-3 py-[7px] text-[13px] text-text-muted" aria-hidden="true" tabindex="-1">Limpiar filtros</button>
  </div>
  <div class="relative min-h-0 flex-1 overflow-auto overscroll-contain">
    <div class="sticky top-0 left-0 z-40 -mb-0.5 h-0.5 overflow-hidden" aria-hidden="true"><div class="h-full w-2/5 translate-x-full bg-primary"></div></div>
    <table class="w-full border-collapse">
      <thead>
        <tr class="text-xs font-semibold text-text-muted">
          <th class="sticky top-0 left-0 z-30 h-9 w-9 border-b border-line bg-head"><input type="checkbox" aria-label="Seleccionar todo" class="accent-primary"></th>
          <th class="sticky top-0 left-9 z-30 h-9 border-b border-line bg-head px-3 text-left shadow-[1px_0_0_var(--line-2)]">Razón social ▲</th>
          <th class="sticky top-0 z-20 h-9 border-b border-line bg-head px-3 text-left">NIT</th>
          <th class="sticky top-0 z-20 h-9 border-b border-line bg-head px-3 text-left">DIAN</th>
          <th class="sticky top-0 z-20 h-9 border-b border-line bg-head px-3 text-right">Cupo</th>
          <th class="sticky top-0 z-20 h-9 border-b border-line bg-head px-3 text-right">Saldo</th>
        </tr>
        <tr>
          <th class="sticky top-9 left-0 z-30 h-9 border-b border-line bg-head"></th>
          <th class="sticky top-9 left-9 z-30 h-9 border-b border-line bg-head px-3 shadow-[1px_0_0_var(--line-2)]"><input class="h-[26px] w-full rounded-[4px] border border-primary bg-accent px-1.5 text-xs font-semibold shadow-[inset_3px_0_0_var(--primary)]" value="café" aria-label="Filtrar Razón social"></th>
          <th class="sticky top-9 z-20 h-9 border-b border-line bg-head px-3"><input class="h-[26px] w-full rounded-[4px] border border-line-input bg-surface px-1.5 text-xs" placeholder="contiene…" aria-label="Filtrar NIT"></th>
          <th class="sticky top-9 z-20 h-9 border-b border-line bg-head px-3"><select class="h-[26px] w-full rounded-[4px] border border-line-input bg-surface text-xs" aria-label="Filtrar DIAN"><option>Todos</option></select></th>
          <th class="sticky top-9 z-20 h-9 border-b border-line bg-head px-3"><input class="h-[26px] w-full rounded-[4px] border border-line-input bg-surface px-1.5 text-right text-xs" placeholder="≥ 1000" aria-label="Filtrar Cupo"></th>
          <th class="sticky top-9 z-20 h-9 border-b border-line bg-head px-3"><input disabled class="h-[26px] w-full rounded-[4px] border border-line bg-head px-1.5 text-xs" placeholder="enmascarado" aria-label="Filtro no disponible"></th>
        </tr>
      </thead>
      <tbody>
        <tr tabindex="-1" class="cursor-pointer hover:bg-hover">
          <td class="sticky left-0 z-10 h-9 border-b border-line-2 bg-surface text-center"><input type="checkbox" tabindex="-1" class="accent-primary" aria-label="Seleccionar fila"></td>
          <td class="sticky left-9 z-10 h-9 border-b border-line-2 bg-surface px-3 whitespace-nowrap shadow-[1px_0_0_var(--line-2)]">Café del Valle S.A.S.</td>
          <td class="h-9 border-b border-line-2 px-3 font-mono text-[13px] tabular-nums">901234567-1</td>
          <td class="h-9 border-b border-line-2 px-3"><span class="rounded-[4px] bg-ok-bg px-2 py-0.5 text-xs text-ok">Completo</span></td>
          <td class="h-9 border-b border-line-2 px-3 text-right tabular-nums">$ 25.000.000,00</td>
          <td class="h-9 border-b border-line-2 px-3 text-right tracking-[1px] text-text-muted" title="Valor enmascarado">••••••</td>
        </tr>
        <tr tabindex="0" aria-selected="true" class="cursor-pointer bg-accent outline-2 -outline-offset-2 outline-focus-ring">
          <td class="sticky left-0 z-10 h-9 border-b border-line-2 bg-accent text-center"><input type="checkbox" checked tabindex="-1" class="accent-primary" aria-label="Seleccionar fila"></td>
          <td class="sticky left-9 z-10 h-9 border-b border-line-2 bg-accent px-3 whitespace-nowrap shadow-[1px_0_0_var(--line-2)]">Cafetería La Molienda</td>
          <td class="h-9 border-b border-line-2 px-3 font-mono text-[13px] tabular-nums">1020304050</td>
          <td class="h-9 border-b border-line-2 px-3"><span class="rounded-[4px] bg-warn-bg px-2 py-0.5 text-xs text-warn">Faltan 3</span></td>
          <td class="h-9 border-b border-line-2 px-3 text-right tabular-nums">$ 1.234.567,00</td>
          <td class="h-9 border-b border-line-2 px-3 text-right tracking-[1px] text-text-muted">••••••</td>
        </tr>
      </tbody>
      <tfoot>
        <tr class="text-[13px] font-semibold">
          <td class="sticky bottom-0 left-0 z-20 h-8 border-t border-line bg-head"></td>
          <td class="sticky bottom-0 left-9 z-20 h-8 border-t border-line bg-head px-3 shadow-[1px_0_0_var(--line-2)]">Total del filtro</td>
          <td class="sticky bottom-0 z-10 h-8 border-t border-line bg-head"></td><td class="sticky bottom-0 z-10 h-8 border-t border-line bg-head"></td>
          <td class="sticky bottom-0 z-10 h-8 border-t border-line bg-head px-3 text-right tabular-nums">$ 26.234.567,00</td>
          <td class="sticky bottom-0 z-10 h-8 border-t border-line bg-head px-3 text-right text-text-muted">—</td>
        </tr>
      </tfoot>
    </table>
  </div>
  <div class="flex h-10 items-center gap-4 overflow-x-auto border-t border-line-2 bg-head px-3.5 text-[13px] whitespace-nowrap text-text-muted">
    <span>1–50 de 482</span>
    <nav class="inline-flex items-center gap-1" aria-label="Página 1 de 10"><button class="h-[26px] min-w-7 rounded-[4px] border border-line bg-surface px-1.5 text-xs" disabled>‹</button><button aria-current="page" class="h-[26px] min-w-7 rounded-[4px] border border-primary bg-primary px-1.5 text-xs text-white">1</button><button class="h-[26px] min-w-7 rounded-[4px] border border-line bg-surface px-1.5 text-xs">2</button><span>…</span><button class="h-[26px] min-w-7 rounded-[4px] border border-line bg-surface px-1.5 text-xs">10</button><button class="h-[26px] min-w-7 rounded-[4px] border border-line bg-surface px-1.5 text-xs">›</button></nav>
    <span class="ml-auto inline-flex items-center gap-4"><b class="text-text">1 seleccionado</b><span class="tabular-nums">Cupo: $ 1.234.567,00</span><span class="text-[11px]">↑↓ moverse · Espacio seleccionar · Enter abrir · / filtrar</span></span>
  </div>
</section>
```

### 2.10 `packages/ui/src/grid/FilterRow.tsx`

**UX Friction Analysis**
- There is no keyboard grammar. Esc does not clear a filter; it has to be selected and deleted. Enter does not apply at once, so the user waits out the 300 ms debounce (`use-grid.ts:32`). Nothing leads from the filter row down into the rows (`:78-86`).
- An active filter is shown only by tint and border colour (`components.css:64`), so it fails WCAG 1.4.1 for users with colour-vision deficiency.
- Two native date inputs per date column at `min-width: 72px` (`:66-70`) truncate to "dd/mm/a" in 13 px. Users then cannot check the range they typed.
- The masked column's disabled input says "enmascarado" only as a placeholder. That is fine, and the input is correctly unfocusable.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/grid/FilterRow.tsx
+++ b/packages/ui/src/grid/FilterRow.tsx
@@
+import type { KeyboardEvent } from "react";
 import { useTranslations } from "next-intl";
+import { cn } from "@erp/ui/lib/utils";
@@ export interface FilterRowProps {
   /** The grid has a selection column first. */
   selectable?: boolean;
+  /** The first data column is sticky (the grid's identity column). */
+  stickyFirst?: boolean;
+  /** ↓ from a filter: the grid puts the caret on its active row. */
+  onLeaveDown?: () => void;
 }
@@
-export function FilterRow({ columns, values, onChange, selectable }: FilterRowProps) {
+export function FilterRow({ columns, values, onChange, selectable, stickyFirst, onLeaveDown }: FilterRowProps) {
   const t = useTranslations();
   const optionsOf = useOptions();
+  // Esc clears this filter, Enter applies it now (no debounce), ↓ goes to the rows (a select keeps ↓ for its options).
+  const keys = (field: string, current: () => string) => (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
+    if (event.key === "Escape" && current() !== "") {
+      event.preventDefault();
+      event.stopPropagation();
+      onChange(field, undefined, false);
+    } else if (event.key === "Enter") {
+      event.preventDefault();
+      onChange(field, current() || undefined, false);
+    } else if (event.key === "ArrowDown" && event.currentTarget.tagName === "INPUT" && (event.currentTarget as HTMLInputElement).type !== "date") {
+      event.preventDefault();
+      onLeaveDown?.();
+    }
+  };
   return (
     <tr className="erp-grid__filters" aria-label={t("grid.filter_row")}>
-      {selectable && <th />}
-      {columns.map((column) => {
+      {selectable && <th className="erp-grid__check" />}
+      {columns.map((column, i) => {
+        const cell = cn(stickyFirst && i === 0 && "erp-grid__id");
@@
         if (column.mode === "masked") {
           return (
-            <th key={column.field}>
+            <th key={column.field} className={cell || undefined}>
@@
-              <select aria-label={label} className={on} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(column.field, e.target.value || undefined, false)}>
+              <select aria-label={label} aria-keyshortcuts="Escape" className={on} value={typeof value === "string" ? value : ""} onKeyDown={keys(column.field, () => (typeof value === "string" ? value : ""))} onChange={(e) => onChange(column.field, e.target.value || undefined, false)}>
@@
-                <input type="date" aria-label={`${label} · ${t("grid.date_from")}`} className={on} value={range.from} onChange={(e) => set("from", e.target.value)} />
-                <input type="date" aria-label={`${label} · ${t("grid.date_to")}`} className={on} value={range.to} onChange={(e) => set("to", e.target.value)} />
+                <input type="date" aria-label={`${label} · ${t("grid.date_from")}`} className={on} value={range.from} max={range.to || undefined} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onChange(column.field, undefined, false))} onChange={(e) => set("from", e.target.value)} />
+                <input type="date" aria-label={`${label} · ${t("grid.date_to")}`} className={on} value={range.to} min={range.from || undefined} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onChange(column.field, undefined, false))} onChange={(e) => set("to", e.target.value)} />
@@
               <input
                 aria-label={label}
+                aria-keyshortcuts="Escape Enter"
                 className={on}
                 inputMode={numeric ? "decimal" : undefined}
                 placeholder={numeric ? t("grid.filter_number") : t("grid.filter_text")}
                 style={numeric ? { textAlign: "right" } : undefined}
                 value={typeof value === "string" ? value : ""}
+                onKeyDown={keys(column.field, () => (typeof value === "string" ? value : ""))}
                 onChange={(e) => onChange(column.field, e.target.value, true)}
               />
```
(Every `<th key={column.field}>` gets `className={cell || undefined}` the same way; only the first is shown.)

**Pure Tailwind & SVG Prototype Block**: one filter row with text, active, number, select, date range and masked cells.
```html
<table class="w-full border-collapse bg-surface text-xs">
  <tr>
    <th class="h-9 border-b border-line bg-head px-3"><input class="h-[26px] w-full rounded-[4px] border border-primary bg-accent px-1.5 font-semibold shadow-[inset_3px_0_0_var(--primary)] focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus-ring" value="café" aria-label="Filtrar Razón social" aria-keyshortcuts="Escape Enter"></th>
    <th class="h-9 border-b border-line bg-head px-3"><input class="h-[26px] w-full rounded-[4px] border border-line-input bg-surface px-1.5 text-right" placeholder="≥ 1000 o 1000..5000" aria-label="Filtrar Cupo"></th>
    <th class="h-9 border-b border-line bg-head px-3"><select class="h-[26px] w-full rounded-[4px] border border-line-input bg-surface" aria-label="Filtrar Relación"><option>Todos</option><option>Cliente</option></select></th>
    <th class="h-9 border-b border-line bg-head px-3"><span class="flex gap-1"><input type="date" class="h-[26px] min-w-[118px] rounded-[4px] border border-line-input bg-surface px-1" aria-label="Creado desde"><input type="date" class="h-[26px] min-w-[118px] rounded-[4px] border border-line-input bg-surface px-1" aria-label="Creado hasta"></span></th>
    <th class="h-9 border-b border-line bg-head px-3"><input disabled class="h-[26px] w-full rounded-[4px] border border-line bg-head px-1.5" placeholder="enmascarado" aria-label="Filtro no disponible"></th>
  </tr>
</table>
```

### 2.11 `packages/ui/src/grid/GridFooter.tsx`

**UX Friction Analysis**
- `flex-wrap: wrap` (`components.css:77`) with a selection block that mounts at the first checked row (`:60-69`). The footer grows to two lines and the scrolling body shrinks by about 30 px just as the user ticks rows, so the next row moves under the pointer.
- The filter totals are inline text ("Suma del filtro de cupo: $ …", `:55-59`), so the user has to read prose to find a number. Money is compared vertically, so the amount should sit under its column (OD-5, see §2.9).
- On the first load it says "0–0 de 0" (`:28`) before anything has loaded.
- The pager is 26 px tall on touch (L8).

**Proposed Code Diff**
```diff
--- a/packages/ui/src/grid/GridFooter.tsx
+++ b/packages/ui/src/grid/GridFooter.tsx
@@ export interface GridFooterProps {
   page: number;
   pageSize: number;
   total: number;
+  /** The first page is still on its way: counts are not known yet. */
+  loading?: boolean;
@@
-export function GridFooter({ page, pageSize, total, onPage, onPageSize, sums = [], selection }: GridFooterProps) {
+export function GridFooter({ page, pageSize, total, loading = false, onPage, onPageSize, sums = [], selection }: GridFooterProps) {
@@
   return (
     <div className="erp-grid__ft">
-      <span>{t("grid.rows", { from, to, total })}</span>
+      <span className="erp-num">{loading ? t("grid.loading") : t("grid.rows", { from, to, total })}</span>
       <nav className="erp-pager" aria-label={t("grid.page", { page, pages })}>
@@
       </nav>
-      {sums.map(({ column, sum }) => (
-        <span key={column.field} className="erp-num">
-          {t("grid.sum_filtered", { label: column.label.toLowerCase(), amount: formatMoney(sum as number | string) || formatMoney(0) })}
-        </span>
-      ))}
-      {selection && selection.count > 0 && (
-        <span className="erp-grid__selection">
-          <b>{t("grid.selected", { count: selection.count })}</b>
-          {selection.totals.map(({ column, sum }) => (
-            <span key={column.field} className="erp-num">
-              {t("grid.selection_sum", { label: column.label, amount: formatMoney(sum) })}
-            </span>
-          ))}
-        </span>
-      )}
+      {/* One line, right-aligned group: the selection appears in place, nothing wraps (the footer scrolls sideways if it must). */}
+      <span className="erp-grid__ft-end">
+        {sums.map(({ column, sum }) => (
+          <span key={column.field} className="erp-num">
+            {t("grid.sum_filtered", { label: column.label.toLowerCase(), amount: formatMoney(sum as number | string) || formatMoney(0) })}
+          </span>
+        ))}
+        <span className="erp-grid__selection" role="status" aria-live="polite">
+          {selection && selection.count > 0 && (
+            <>
+              <b>{t("grid.selected", { count: selection.count })}</b>
+              {selection.totals.map(({ column, sum }) => (
+                <span key={column.field} className="erp-num">
+                  {t("grid.selection_sum", { label: column.label, amount: formatMoney(sum) })}
+                </span>
+              ))}
+            </>
+          )}
+        </span>
+        <span className="erp-grid__keys" aria-hidden="true">{t("grid.keys_hint")}</span>
+      </span>
     </div>
```
(If OD-5 is accepted, `DataGrid` passes `sums={[]}` because the totals live in `<tfoot>`.)

**Pure Tailwind & SVG Prototype Block**
```html
<div class="flex h-10 w-[900px] items-center gap-4 overflow-x-auto border-t border-line-2 bg-head px-3.5 text-[13px] whitespace-nowrap text-text-muted">
  <span class="tabular-nums">51–100 de 482</span>
  <nav class="inline-flex items-center gap-1" aria-label="Página 2 de 10">
    <button class="h-[26px] min-w-7 rounded-[4px] border border-line bg-surface px-1.5 text-xs text-text" aria-label="Anterior">‹</button>
    <button class="h-[26px] min-w-7 rounded-[4px] border border-line bg-surface px-1.5 text-xs text-text">1</button>
    <button aria-current="page" class="h-[26px] min-w-7 rounded-[4px] border border-primary bg-primary px-1.5 text-xs text-white">2</button>
    <button class="h-[26px] min-w-7 rounded-[4px] border border-line bg-surface px-1.5 text-xs text-text">3</button><span>…</span>
    <button class="h-[26px] min-w-7 rounded-[4px] border border-line bg-surface px-1.5 text-xs text-text">10</button>
    <select class="h-[26px] rounded-[4px] border border-line bg-surface text-xs text-text" aria-label="Filas por página"><option>50 por página</option></select>
  </nav>
  <span class="ml-auto inline-flex items-center gap-4">
    <span role="status"><b class="text-text">3 seleccionados</b> <span class="tabular-nums">Cupo: $ 41.234.567,00</span></span>
    <span class="text-[11px]" aria-hidden="true">↑↓ moverse · Espacio seleccionar · Enter abrir · / filtrar</span>
  </span>
</div>
```

### 2.12 `packages/ui/src/grid/AdvancedFilter.tsx`

**UX Friction Analysis**
- The live-result rows (`:136-142`) are `tr` elements with `onClick` and no `tabIndex` or key handler. The row pick that rule 20 requires, and that `EntityLookup` relies on for "pick" mode (invoice lines in phase 2), cannot be done from the keyboard (H8).
- Enter in a value box does nothing. The user must Tab through ✕, "Añadir regla", the hint and the 50 result rows to reach "Aplicar".
- The live preview is replaced on every keystroke (`setResults`, `:71-74`). Between results the old rows stay, with no "Buscando…" state, so the user may pick a row that the new conditions no longer match.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/grid/AdvancedFilter.tsx
+++ b/packages/ui/src/grid/AdvancedFilter.tsx
@@
-import { Fragment, useEffect, useRef, useState } from "react";
+import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
@@
   const [results, setResults] = useState<GridPage | null>(null);
+  const [searching, setSearching] = useState(false);
+  const [activeResult, setActiveResult] = useState(0);
+  const resultsRef = useRef<HTMLTableSectionElement>(null);
@@
   useEffect(() => {
     let cancelled = false;
+    setSearching(true);
     const timer = setTimeout(() => {
       previewRef.current(JSON.parse(liveKey) as Condition[]).then(
-        (page) => !cancelled && setResults(page),
-        () => !cancelled && setResults({ rows: [], total: 0 }),
+        (page) => !cancelled && (setResults(page), setActiveResult(0), setSearching(false)),
+        () => !cancelled && (setResults({ rows: [], total: 0 }), setSearching(false)),
       );
     }, debounceMs);
@@
+  const resultRows = (results?.rows ?? []).slice(0, PREVIEW_ROWS);
+  const focusResult = (index: number) => {
+    const next = Math.max(0, Math.min(resultRows.length - 1, index));
+    setActiveResult(next);
+    resultsRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]")[next]?.focus();
+  };
+  // In the conditions: Enter applies (a multiple select keeps Enter), ↓ from the last value box goes to the results.
+  const onConditionsKey = (event: KeyboardEvent<HTMLDivElement>) => {
+    const target = event.target as HTMLElement;
+    if (event.key === "Enter" && !(target instanceof HTMLSelectElement && target.multiple) && target.tagName !== "BUTTON") {
+      event.preventDefault();
+      if (mode === "pick" && resultRows.length === 1) pick(resultRows[0]!);
+      else apply();
+    } else if (event.key === "ArrowDown" && event.altKey && resultRows.length > 0) {
+      event.preventDefault();
+      focusResult(0);
+    }
+  };
+  const onResultKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: GridRow) => {
+    const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: resultRows.length - 1 };
+    if (event.key in moves) {
+      event.preventDefault();
+      focusResult(moves[event.key]!);
+    } else if (event.key === "Enter" || event.key === " ") {
+      event.preventDefault();
+      pick(row);
+    }
+  };
@@
-        <div className="erp-adv">
+        <div className="erp-adv" onKeyDown={onConditionsKey} aria-keyshortcuts="Enter Alt+ArrowDown">
@@
-            {t("grid.adv.results")} <Pill tone="gray">{t("grid.results", { count: total })}</Pill>{" "}
+            {t("grid.adv.results")} <Pill tone="gray">{searching ? t("grid.adv.searching") : t("grid.results", { count: total })}</Pill>{" "}
@@
-          <div className="erp-adv__table">
+          <div className="erp-adv__table" aria-busy={searching} style={{ opacity: searching ? 0.6 : 1 }}>
@@
-              <tbody>
-                {(results?.rows ?? []).slice(0, PREVIEW_ROWS).map((row) => {
+              <tbody ref={resultsRef}>
+                {resultRows.map((row, index) => {
                   const reason = blockedReason?.(row) ?? null;
                   return (
                     <tr
                       key={row.id}
+                      data-row
+                      tabIndex={index === activeResult ? 0 : -1}
                       className={reason ? "erp-row-link is-blocked" : "erp-row-link"}
                       title={reason ? t("grid.adv.not_invoiceable", { reasons: reason }) : undefined}
                       aria-disabled={reason ? true : undefined}
+                      onFocus={() => setActiveResult(index)}
+                      onKeyDown={(event) => onResultKey(event, index, row)}
                       onClick={() => pick(row)}
                     >
```

**Pure Tailwind & SVG Prototype Block**
```html
<div class="flex w-[860px] flex-col overflow-hidden rounded-lg border border-line bg-surface text-[13px]">
  <div class="flex items-center gap-2 border-b border-line-2 px-[18px] py-3"><b class="grow text-[15px]">Filtro avanzado · Terceros</b><button class="rounded-md px-2 text-text-muted" aria-label="Cerrar">✕</button></div>
  <div class="flex flex-col gap-3 p-[18px]">
    <div class="grid grid-cols-[72px_200px_160px_1fr_auto] items-center gap-1.5" role="group" aria-label="Regla 1">
      <span class="text-center text-xs font-bold text-text-muted">Donde</span>
      <select class="h-8 rounded-[4px] border border-line-input bg-surface px-2 text-xs"><option>Municipio</option></select>
      <select class="h-8 rounded-[4px] border border-line-input bg-surface px-2 text-xs"><option>es</option></select>
      <input class="h-8 rounded-[4px] border border-line-input bg-surface px-2 text-xs outline-2 outline-offset-1 outline-focus-ring" value="Medellín" aria-keyshortcuts="Enter Alt+ArrowDown">
      <button class="rounded-md px-2 text-text-muted" aria-label="Quitar regla">✕</button>
    </div>
    <section aria-label="Resultados">
      <h3 class="m-0 mb-1.5 text-xs font-bold tracking-[.04em] text-text-muted uppercase">Resultados <span class="rounded-[4px] bg-line-2 px-2 py-0.5 normal-case">Buscando…</span> <span class="font-normal normal-case">Enter aplica · Alt+↓ va a los resultados · Enter elige</span></h3>
      <div class="max-h-[200px] overflow-auto rounded-md border border-line-2 opacity-60" aria-busy="true">
        <table class="w-full border-collapse">
          <thead><tr><th class="sticky top-0 h-9 border-b border-line bg-head px-3 text-left text-xs text-text-muted">Razón social</th><th class="sticky top-0 h-9 border-b border-line bg-head px-3 text-left text-xs text-text-muted">NIT</th><th class="sticky top-0 h-9 border-b border-line bg-head px-3 text-left text-xs text-text-muted">Facturable</th></tr></thead>
          <tbody>
            <tr tabindex="0" class="cursor-pointer bg-hover outline-2 -outline-offset-2 outline-focus-ring"><td class="h-9 border-b border-line-2 px-3">Tostadora Antioquia S.A.S.</td><td class="h-9 border-b border-line-2 px-3 font-mono tabular-nums">900111222-3</td><td class="h-9 border-b border-line-2 px-3"><span class="rounded-[4px] bg-ok-bg px-2 py-0.5 text-xs text-ok">Sí</span></td></tr>
            <tr tabindex="-1" aria-disabled="true" class="cursor-not-allowed opacity-55"><td class="h-9 border-b border-line-2 px-3">Granos del Sur</td><td class="h-9 border-b border-line-2 px-3 font-mono tabular-nums">71234567</td><td class="h-9 border-b border-line-2 px-3"><span class="rounded-[4px] bg-danger-bg px-2 py-0.5 text-xs text-danger">No · faltan datos DIAN</span></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
  <div class="flex items-center justify-end gap-2 border-t border-line-2 bg-head px-[18px] py-3"><span class="grow text-xs text-text-muted">El grid mostrará 37 registros</span><button class="rounded-md border border-line bg-surface px-3 py-[7px]">Cancelar</button><button class="rounded-md bg-primary px-3 py-[7px] font-semibold text-white">Aplicar</button></div>
</div>
```

### 2.13 `packages/ui/src/grid/use-popover.ts` (Columnas, Guardar vista)

**UX Friction Analysis**
- Opening the popover leaves focus on the trigger (`:9-23`). To reach the first checkbox the user tabs on, and the next Tab target depends on DOM order. Esc closes the panel (`:15`) but does not hand focus back, so it lands on `<body>`. Tabbing away leaves the panel open over the grid.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/grid/use-popover.ts
+++ b/packages/ui/src/grid/use-popover.ts
@@
-/** A small panel anchored to a button: opens on click, closes on Escape or a click outside. */
+const FOCUSABLE = "input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex='0']";
+
+/**
+ * A small panel anchored to a button: opens on click with the caret on its first control, closes on Escape, a click
+ * outside or the caret leaving it, and gives the caret back to its button on Escape.
+ */
 export function usePopover<T extends HTMLElement = HTMLDivElement>() {
   const [open, setOpen] = useState(false);
   const ref = useRef<T | null>(null);
   useEffect(() => {
     if (!open) return;
+    const root = ref.current;
+    const trigger = root?.querySelector<HTMLElement>("button");
+    requestAnimationFrame(() => root?.querySelector<HTMLElement>(`.erp-pop__panel :is(${FOCUSABLE})`)?.focus());
     const onDown = (event: MouseEvent) => {
-      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
+      if (root && !root.contains(event.target as Node)) setOpen(false);
     };
     const onKey = (event: KeyboardEvent) => {
-      if (event.key === "Escape") setOpen(false);
+      if (event.key !== "Escape") return;
+      event.stopPropagation();
+      setOpen(false);
+      trigger?.focus();
     };
+    const onFocusOut = (event: FocusEvent) => {
+      if (root && event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) setOpen(false);
+    };
     document.addEventListener("mousedown", onDown);
     document.addEventListener("keydown", onKey);
+    root?.addEventListener("focusout", onFocusOut);
     return () => {
       document.removeEventListener("mousedown", onDown);
       document.removeEventListener("keydown", onKey);
+      root?.removeEventListener("focusout", onFocusOut);
     };
   }, [open]);
```

**Pure Tailwind & SVG Prototype Block**
```html
<div class="relative inline-block">
  <button aria-expanded="true" class="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-[7px] text-[13px]">Columnas</button>
  <div role="group" aria-label="Columnas" class="absolute top-[calc(100%+4px)] right-0 z-30 flex max-h-[360px] min-w-[220px] flex-col gap-1.5 overflow-auto rounded-lg border border-line bg-surface p-2.5 text-[13px] shadow-[0_10px_30px_var(--shadow)]">
    <div class="text-[11px] font-bold tracking-[.04em] text-text-muted uppercase">6 de 9 columnas</div>
    <label class="flex items-center gap-2"><input type="checkbox" checked class="accent-primary outline-2 outline-offset-1 outline-focus-ring">Razón social</label>
    <label class="flex items-center gap-2"><input type="checkbox" checked class="accent-primary">NIT</label>
    <label class="flex items-center gap-2"><input type="checkbox" class="accent-primary">Municipio</label>
    <button class="self-start rounded-md px-2 py-1 text-xs text-text-muted">Restablecer</button>
  </div>
</div>
```

### 2.14 `packages/ui/src/grid/SavedViewsMenu.tsx`

**UX Friction Analysis**
- ✕ next to each saved view (`:61-63`) deletes it on the first click, with no confirmation and no undo. It sits 4 px from the "apply" button, so on an 8-hour shift a mis-aimed click destroys a colleague-promoted view.
- The button label says "Guardar vista" but the panel also applies views. Applying is the more frequent action and should come first in focus order (it already comes first in the DOM, which is fine).

**Proposed Code Diff**
```diff
--- a/packages/ui/src/grid/SavedViewsMenu.tsx
+++ b/packages/ui/src/grid/SavedViewsMenu.tsx
@@
   const [busy, setBusy] = useState(false);
+  // ✕ asks first: the second click within 4 s (or Enter on the "¿Eliminar?" button) deletes.
+  const [arming, setArming] = useState<string | null>(null);
+  useEffect(() => {
+    if (!arming) return;
+    const timer = setTimeout(() => setArming(null), 4000);
+    return () => clearTimeout(timer);
+  }, [arming]);
@@
-                {onDelete && (
-                  <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm" aria-label={t("grid.views.remove", { name: view.name })} onClick={() => void onDelete(view.id)}>
-                    ✕
-                  </button>
-                )}
+                {onDelete &&
+                  (arming === view.id ? (
+                    <button type="button" className="erp-btn erp-btn--sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }} autoFocus onClick={() => (setArming(null), void onDelete(view.id))}>
+                      {t("grid.views.confirm_remove", { name: view.name })}
+                    </button>
+                  ) : (
+                    <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm" aria-label={t("grid.views.remove", { name: view.name })} onClick={() => setArming(view.id)}>
+                      ✕
+                    </button>
+                  ))}
```
(`useEffect` joins the `react` import.)

**Pure Tailwind & SVG Prototype Block**
```html
<ul class="m-0 flex w-[300px] list-none flex-col gap-0.5 rounded-lg border border-line bg-surface p-2.5 text-[13px]">
  <li class="flex items-center gap-2"><button class="grow rounded-md px-2 py-1 text-left">★ Clientes Antioquia <span class="text-[11px] text-text-muted">· predeterminada</span></button><button class="rounded-md px-2 py-1 text-text-muted" aria-label="Eliminar Clientes Antioquia">✕</button></li>
  <li class="flex items-center gap-2"><button class="grow rounded-md px-2 py-1 text-left">Proveedores sin RUT</button><button class="rounded-md border border-danger px-2 py-1 text-xs text-danger outline-2 outline-offset-1 outline-focus-ring">¿Eliminar Proveedores sin RUT?</button></li>
</ul>
```

### 2.15 `packages/ui/src/grid/use-grid-export.ts`

**UX Friction Analysis**
- `useEffect(() => () => running.current?.abort(), [])` (`:43`) cancels the export when the grid unmounts. Activating another tab navigates (`AppShell.tsx:128-136`), and the router then unmounts the grid page. A 20,000-row Excel job that the server is still building (`phase: "job"`) is dropped, and the file never downloads (H7).
- Progress is a single string. A job has no "rows written so far" (the server already counts them, `kernel/src/exports/render.ts:17`) and no elapsed time.

**Proposed Code Diff**: move running exports to a shell-level store that outlives the grid. When a job finishes off-screen, the shell's `sonner` toast reports it.
```tsx
// packages/ui/src/grid/export-jobs.tsx (new) — exports keep running while the user works in other tabs.
"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface ExportJobs {
  /** Starts `work` unless one runs for `key`; the promise survives the grid that asked for it. */
  start: (key: string, work: (signal: AbortSignal) => Promise<string>) => Promise<string | null>;
  cancel: (key: string) => void;
}
const Context = createContext<ExportJobs | null>(null);

export function ExportJobsProvider({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const running = useRef(new Map<string, AbortController>());
  const value: ExportJobs = {
    async start(key, work) {
      if (running.current.has(key)) return null;
      const controller = new AbortController();
      running.current.set(key, controller);
      try {
        const fileName = await work(controller.signal);
        toast(t("grid.export.ready", { file: fileName }));
        return fileName;
      } finally {
        running.current.delete(key);
      }
    },
    cancel: (key) => running.current.get(key)?.abort(),
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useExportJobs = () => useContext(Context);
```
```diff
--- a/packages/ui/src/grid/use-grid-export.ts
+++ b/packages/ui/src/grid/use-grid-export.ts
@@
+import { useExportJobs } from "./export-jobs";
@@
 export function useGridExport({ entity, title, endpoint, fetcher, pollMs, maxWaitMs, download = browserDownload }: UseGridExportOptions) {
   const [status, setStatus] = useState<ExportStatus>({ phase: "idle" });
   const running = useRef<AbortController | null>(null);
-  useEffect(() => () => running.current?.abort(), []);
+  const jobs = useExportJobs();
+  // Inside the shell the job belongs to ExportJobsProvider and survives this grid; only a bare grid (tests) aborts on unmount.
+  const mounted = useRef(true);
+  useEffect(() => {
+    mounted.current = true;
+    return () => {
+      mounted.current = false;
+      if (!jobs) running.current?.abort();
+    };
+  }, [jobs]);
+  const setIfMounted = (next: ExportStatus) => mounted.current && setStatus(next);
@@
-      setStatus({ phase: "working", format });
+      setIfMounted({ phase: "working", format });
       try {
-        const result = await requestExport(
-          { entity, format, state, ...(title ? { title } : {}) },
-          { endpoint, fetcher, pollMs, maxWaitMs, signal: controller.signal, onJob: () => setStatus({ phase: "job", format }) },
-        );
-        download(result);
-        setStatus({ phase: "ready", fileName: result.fileName ?? `${entity}.${format}` });
+        const work = async (signal: AbortSignal) => {
+          const result = await requestExport(
+            { entity, format, state, ...(title ? { title } : {}) },
+            { endpoint, fetcher, pollMs, maxWaitMs, signal, onJob: () => setIfMounted({ phase: "job", format }) },
+          );
+          download(result);
+          return result.fileName ?? `${entity}.${format}`;
+        };
+        const fileName = jobs ? await jobs.start(`${entity}:${format}`, work) : await work(controller.signal);
+        if (fileName) setIfMounted({ phase: "ready", fileName });
```
`AppShell` wraps its children in `<ExportJobsProvider>` next to `CellFormatProvider`. The "ready" status clears itself after 8 s (`setTimeout(() => setIfMounted({ phase: "idle" }), 8000)`), which closes L10.

**Pure Tailwind & SVG Prototype Block**: the toast the shell shows when a job finishes in another tab.
```html
<div role="status" class="fixed bottom-4 left-1/2 flex w-[420px] -translate-x-1/2 items-center gap-3 rounded-lg bg-[var(--toast-bg,#111827)] px-4 py-3 text-[13px] text-[var(--toast-text,#fff)] shadow-[0_10px_30px_rgba(0,0,0,.25)]">
  <svg viewBox="0 0 24 24" class="size-4 shrink-0 text-[#6BCB8B]" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
  <span class="grow">Archivo listo: <span class="font-mono">terceros-2026-10-28.xlsx</span> · 20.418 filas</span>
  <button class="text-xs underline">Descargar de nuevo</button>
</div>
```

### 2.16 `packages/ui/src/forms/form-parts.tsx`

**UX Friction Analysis**
- `Field` (`:27-43`) prints the hint inside the `<label>` and the error as a sibling `role="alert"`. Neither is linked with `aria-describedby`, so a screen reader reads the hint as part of the label ("Tipo de persona AdditionalAccountID") and announces every error as an alert at once. A refused save with 6 issues produces 6 interrupting alerts plus the DIAN panel's.
- `FormActions` (`:275-296`): the save button carries no shortcut, and the status line does not say how to save from the keyboard. On a 30-field party form, Save is reached with Shift+Tab ×1 from the end or Tab ×30 from the start.
- `DianPanel` (`:207-239`) is the summary of refusals, but it cannot take focus, so nothing can send the user to it.
- There is no searchable code picker. `SelectField` is a native `<select>`, fine for 2–20 options but slow for DANE municipalities (about 1,100), CIIU (about 500) and countries (about 250). Native type-ahead only matches the start of the visible text, and that text begins with the code ("05001 · Medellín").

**Proposed Code Diff**
```diff
--- a/packages/ui/src/forms/form-parts.tsx
+++ b/packages/ui/src/forms/form-parts.tsx
@@
-import { useId, type ReactNode } from "react";
+import { useId, useState, type ReactNode } from "react";
+import { Command } from "cmdk";
 import { useTranslations } from "next-intl";
+import { fold } from "../shell/CommandPalette";
@@
-/** A labelled control; `children` receives the control's id. */
-export function Field({ label, hint, error, className, children }: { label: ReactNode; hint?: ReactNode; error?: string | null; className?: string; children: (id: string) => ReactNode }) {
+/** A labelled control; `children` receives the control's id and the ids that describe it (hint, error). */
+export function Field({ label, hint, error, className, children }: { label: ReactNode; hint?: ReactNode; error?: string | null; className?: string; children: (id: string, describedBy?: string) => ReactNode }) {
   const id = useId();
+  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
   return (
     <div className={["erp-field", className].filter(Boolean).join(" ")}>
       <label htmlFor={id}>
         {label}
-        {hint && <span className="erp-field__hint"> {hint}</span>}
+        {hint && <span id={`${id}-hint`} className="erp-field__hint"> {hint}</span>}
       </label>
-      {children(id)}
+      {children(id, describedBy)}
       {error && (
-        <span role="alert" className="erp-field__error">
+        // Not an alert: the form announces one summary and moves the caret to the first field in error.
+        <span id={`${id}-error`} className="erp-field__error">
           {error}
         </span>
       )}
@@ SelectField
-      {(id) => (
-        <select id={id} value={value} disabled={disabled} aria-invalid={error ? true : undefined} className={error ? "erp-input--bad" : undefined} onChange={(e) => onChange(e.target.value)}>
+      {(id, describedBy) => (
+        <select id={id} value={value} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={error ? "erp-input--bad" : undefined} onChange={(e) => onChange(e.target.value)}>
@@ TextField
-      {(id) => (
+      {(id, describedBy) => (
         <input
           id={id}
@@
           aria-invalid={error ? true : undefined}
+          aria-describedby={describedBy}
@@
+/**
+ * A code table with search (DANE municipalities, CIIU, countries): type any part of the code or the name. The options
+ * are the pack's; the value is the code, as with SelectField. Up to 80 matches are listed at once.
+ */
+export function CodeCombobox({ label, hint, error, value, options, onChange, disabled, className }: Omit<SelectFieldProps, "showCode" | "empty">) {
+  const t = useTranslations("common.forms");
+  const [open, setOpen] = useState(false);
+  const [query, setQuery] = useState("");
+  const current = options.find((o) => o.code === value);
+  const q = fold(query);
+  const shown = (q ? options.filter((o) => fold(`${o.code} ${o.name}`).includes(q)) : options).slice(0, 80);
+  const choose = (code: string) => {
+    onChange(code);
+    setOpen(false);
+  };
+  return (
+    <Field label={label} hint={hint} error={error} className={className}>
+      {(id, describedBy) => (
+        <div className="erp-lk" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
+          <Command shouldFilter={false} loop label={typeof label === "string" ? label : undefined}>
+            <Command.Input
+              id={id}
+              disabled={disabled}
+              aria-invalid={error ? true : undefined}
+              aria-describedby={describedBy}
+              className={["erp-lk__input", error && "erp-input--bad"].filter(Boolean).join(" ")}
+              value={open ? query : current ? `${current.code} · ${current.name}` : ""}
+              onFocus={() => (setQuery(""), setOpen(true))}
+              onValueChange={setQuery}
+              onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), setOpen(false))}
+            />
+            {open && (
+              <Command.List className="erp-lk__dd">
+                {shown.map((o) => (
+                  <Command.Item key={o.code} value={o.code} onSelect={() => choose(o.code)} className="erp-lk__item">
+                    <span className="erp-mono erp-small">{o.code}</span> {o.name}
+                  </Command.Item>
+                ))}
+                <Command.Empty className="erp-lk__ft">{t("no_match")}</Command.Empty>
+              </Command.List>
+            )}
+          </Command>
+        </div>
+      )}
+    </Field>
+  );
+}
@@ DianPanel
-      <div className="erp-dian erp-dian--bad" role="alert">
+      <div className="erp-dian erp-dian--bad" role="alert" tabIndex={-1} data-error-summary>
@@ FormActions
-        <span className="erp-small erp-muted erp-grow" role="status">
-          {flow.saving ? t("saving") : status} · <span className="erp-mono">{t("process", { process })}</span>
+        <span className="erp-small erp-muted erp-grow" role="status">
+          {flow.saving ? t("saving") : status} · <span className="erp-mono">{t("process", { process })}</span> · <kbd className="erp-mono">{t("save_hint")}</kbd>
         </span>
@@
-        <button type="button" className="erp-btn erp-btn--primary" onClick={onSave} disabled={blocked || flow.saving || (!dirty && !isNew)}>
+        {/* Stays type="button": with a submit button in the form, Enter in any text box would save (implicit submission). */}
+        <button type="button" className="erp-btn erp-btn--primary" aria-keyshortcuts="Control+S Meta+S Control+Enter Meta+Enter" onClick={onSave} disabled={blocked || flow.saving || (!dirty && !isNew)}>
```
CSS to add with it: `.erp-lk__item[data-selected="true"] { background: var(--accent); }`.

**Pure Tailwind & SVG Prototype Block**: a field with hint and error linked by `aria-describedby`, and the code combobox open on "medel".
```html
<div class="grid w-[720px] grid-cols-3 gap-3 bg-surface p-4 text-[13px]">
  <div class="flex min-w-0 flex-col gap-1">
    <label for="f-doc" class="text-xs font-semibold text-text-muted">Número <span id="f-doc-hint" class="text-[11px] font-normal">solo dígitos · máx. 10</span></label>
    <input id="f-doc" aria-invalid="true" aria-describedby="f-doc-hint f-doc-err" class="rounded-md border border-danger bg-danger-bg px-2.5 py-2 font-mono text-text tabular-nums outline-2 outline-offset-1 outline-focus-ring" value="90037311A">
    <span id="f-doc-err" class="text-[11px] font-semibold text-danger">Solo dígitos para el NIT</span>
  </div>
  <div class="flex min-w-0 flex-col gap-1">
    <label for="f-dv" class="text-xs font-semibold text-text-muted">DV</label>
    <input id="f-dv" readonly class="w-16 rounded-md border border-dashed border-line-input bg-head px-2.5 py-2 text-center font-mono text-text" value="3" title="Dígito de verificación calculado">
  </div>
  <div class="relative flex min-w-0 flex-col gap-1">
    <label for="f-mun" class="text-xs font-semibold text-text-muted">Municipio <span class="text-[11px] font-normal">DANE</span></label>
    <input id="f-mun" role="combobox" aria-expanded="true" aria-controls="f-mun-list" class="rounded-md border border-line-input bg-surface px-2.5 py-2 text-text outline-2 outline-offset-1 outline-focus-ring" value="medel">
    <ul id="f-mun-list" role="listbox" class="absolute top-full right-0 left-0 z-20 mt-1 max-h-[220px] list-none overflow-auto rounded-lg border border-line bg-surface p-0 shadow-[0_10px_30px_var(--shadow)]">
      <li role="option" aria-selected="true" class="flex items-center gap-2.5 bg-accent px-2.5 py-2"><span class="font-mono text-xs">05001</span> Medellín</li>
      <li role="option" class="flex items-center gap-2.5 px-2.5 py-2 hover:bg-accent"><span class="font-mono text-xs">05360</span> Itagüí (Medellín AM)</li>
    </ul>
  </div>
</div>
```

### 2.17 `packages/ui/src/forms/PartyForm.tsx`

**UX Friction Analysis**
- The form is a `<div>` (`:118`). There is no submit path and no Ctrl/⌘+S. A clerk entering 40 parties an hour reaches for the mouse 40 times (H5).
- After a refused save (`flow.failure`) the caret stays on the disabled or still-focused button. Nothing scrolls to or focuses the first `aria-invalid` field, so on a 1,400 px tall form the error is below the fold.
- DV (`:150`) and "Nombre en documentos" (`:168`) are `disabled`. Disabled inputs are skipped by screen readers in browse mode, cannot be copied (the DV is often dictated over the phone) and look like a broken field.
- Municipality (`:223`) is a native select over the department's municipalities (up to 125 for Antioquia, about 1,100 with no department), and Country (`:219`) lists about 250 entries. Type-ahead works only on "05001 · …" prefixes.
- Every label carries a schema hint ("AdditionalAccountID", "schemeName", "TaxScheme", "ISO 3166-1", `:124,134,190,219`). These are useful to an accountant once, but they are noise on the 41st entry, and they wrap labels in the 4-column rows (OD-12, prototype content).

**Proposed Code Diff**
```diff
--- a/packages/ui/src/forms/PartyForm.tsx
+++ b/packages/ui/src/forms/PartyForm.tsx
@@
-import { useState } from "react";
+import { useEffect, useRef, useState, type KeyboardEvent } from "react";
@@
-import { Checks, DianPanel, Field, FieldError, failureMessages, FormActions, InvoicePanel, MaskedField, Section, SelectField, TextField, useErrorText, useFieldLabels } from "./form-parts";
+import { Checks, CodeCombobox, DianPanel, Field, FieldError, failureMessages, FormActions, InvoicePanel, MaskedField, Section, SelectField, TextField, useErrorText, useFieldLabels } from "./form-parts";
@@
   const submit = () => void flow.submit({ ...(record ? { id: record.id } : {}), ...partyInput(draft, { creditLimitVisible: mode("credit_limit") === "visible" }) });
+  const canSave = !readOnly && !blocked && !flow.saving && (dirty || record === null);
+
+  // After a refusal the caret goes to the first field in error (or the DIAN summary when the message has no field).
+  const formRef = useRef<HTMLFormElement>(null);
+  useEffect(() => {
+    if (!flow.failure) return;
+    const form = formRef.current;
+    const target = form?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? form?.querySelector<HTMLElement>("[data-error-summary]");
+    target?.focus();
+    target?.scrollIntoView({ block: "center" });
+  }, [flow.failure]);
+  // Ctrl/⌘+S and Ctrl/⌘+Enter save from any field; Enter alone never submits (the form has more than one text box).
+  const onShortcut = (event: KeyboardEvent<HTMLFormElement>) => {
+    if (!(event.metaKey || event.ctrlKey) || (event.key.toLowerCase() !== "s" && event.key !== "Enter")) return;
+    event.preventDefault();
+    if (canSave) submit();
+  };
 
   return (
-    <div className="erp-form">
+    <form ref={formRef} className="erp-form" noValidate onKeyDown={onShortcut} onSubmit={(e) => e.preventDefault()} aria-keyshortcuts="Control+S Meta+S">
@@
             {tables.checkDigitTypes.includes(draft.documentType) && (
               <Field label={t("dv")} className="erp-field--dv">
-                {(id) => <input id={id} className="erp-mono" disabled value={dv ?? ""} title={t("dv_title")} />}
+                {(id) => <input id={id} className="erp-mono" readOnly tabIndex={-1} value={dv ?? ""} title={t("dv_title")} aria-live="polite" />}
               </Field>
             )}
@@
-              <Field label={t("document_name")}>{(id) => <input id={id} disabled value={composedName(draft)} title={t("document_name_title")} />}</Field>
+              <Field label={t("document_name")}>{(id) => <input id={id} readOnly tabIndex={-1} value={composedName(draft)} title={t("document_name_title")} />}</Field>
@@
-          <SelectField label={t("country")} hint="ISO 3166-1" value={draft.countryCode} disabled={dis} options={tables.countries} error={fe("countryCode")} onChange={set("countryCode")} />
+          <CodeCombobox label={t("country")} hint="ISO 3166-1" value={draft.countryCode} disabled={dis} options={tables.countries} error={fe("countryCode")} onChange={set("countryCode")} />
@@
-              <SelectField label={t("municipality")} hint="DANE" value={draft.municipalityCode} disabled={dis} options={municipalities} empty="—" error={fe("municipalityCode")} onChange={set("municipalityCode")} />
+              <CodeCombobox label={t("municipality")} hint="DANE" value={draft.municipalityCode} disabled={dis} options={municipalities} error={fe("municipalityCode")} onChange={set("municipalityCode")} />
@@
-    </div>
+    </form>
   );
```
(`tabIndex={-1}` keeps the computed boxes out of the Tab order during entry; screen readers still reach them in browse mode, and they can be selected and copied. The same three changes apply to `ProductForm.tsx` and `CategoryForm.tsx`, whose Datos tabs share `form-parts`.)

**Pure Tailwind & SVG Prototype Block**: the identification and location sections at 36 px control height, with the sticky action bar showing the shortcut.
```html
<form class="flex w-[960px] flex-col gap-3 rounded-lg border border-line bg-surface p-[18px] text-[13px]" aria-keyshortcuts="Control+S Meta+S">
  <section class="flex flex-col gap-2 border-b border-line-2 pb-3.5">
    <h3 class="m-0 text-xs font-bold tracking-[.04em] text-text-muted uppercase">Identificación</h3>
    <div class="grid grid-cols-3 gap-3">
      <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted">Tipo de persona<select class="h-9 rounded-md border border-line-input bg-surface px-2 text-[13px] font-normal text-text"><option>1 · Persona jurídica</option></select></label>
      <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted">Tipo de documento<select class="h-9 rounded-md border border-line-input bg-surface px-2 text-[13px] font-normal text-text"><option>31 · NIT</option></select></label>
      <div class="flex items-end gap-2">
        <label class="flex grow flex-col gap-1 text-xs font-semibold text-text-muted">Número<input class="h-9 rounded-md border border-line-input bg-surface px-2.5 font-mono text-[13px] font-normal text-text tabular-nums" value="900373115"></label>
        <label class="flex w-16 flex-col gap-1 text-xs font-semibold text-text-muted">DV<input readonly tabindex="-1" class="h-9 rounded-md border border-dashed border-line-input bg-head text-center font-mono text-[13px] text-text" value="3"></label>
      </div>
    </div>
  </section>
  <section class="flex flex-col gap-2 border-b border-line-2 pb-3.5">
    <h3 class="m-0 text-xs font-bold tracking-[.04em] text-text-muted uppercase">Ubicación</h3>
    <div class="grid grid-cols-4 gap-3">
      <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted">País<input class="h-9 rounded-md border border-line-input bg-surface px-2.5 text-[13px] font-normal text-text" value="CO · Colombia"></label>
      <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted">Departamento<input class="h-9 rounded-md border border-line-input bg-surface px-2.5 text-[13px] font-normal text-text" value="05 · Antioquia"></label>
      <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted">Municipio<input class="h-9 rounded-md border border-line-input bg-surface px-2.5 text-[13px] font-normal text-text" value="05001 · Medellín"></label>
      <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted">Código postal<input class="h-9 rounded-md border border-line-input bg-surface px-2.5 font-mono text-[13px] font-normal text-text" value="050021"></label>
    </div>
  </section>
  <div class="rounded-md bg-ok-bg px-3 py-2.5 text-ok" tabindex="-1"><b>Datos DIAN completos</b></div>
  <div class="sticky bottom-0 flex items-center gap-2 border-t border-line-2 bg-surface pt-2.5">
    <span class="grow text-xs text-text-muted" role="status">Datos DIAN completos al guardar · <span class="font-mono">core.party.update</span> · <kbd class="font-mono">Ctrl+S</kbd></span>
    <button type="button" class="rounded-md border border-line bg-surface px-3 py-[7px]">Descartar</button>
    <button type="button" aria-keyshortcuts="Control+S Meta+S" class="rounded-md bg-primary px-3 py-[7px] font-semibold text-white">Guardar</button>
  </div>
</form>
```

### 2.18 `packages/ui/src/forms/StepUpPrompt.tsx`

**UX Friction Analysis**
- The prompt appears inside the sticky action bar (`form-parts.tsx:281`) or the admin dock without taking focus (`:24-33`). The user must find it and click into it. Esc does not cancel. After 6 digits the user still has to press Enter or click "Confirmar". On admin screens (one code per toggle, H4) that is 3 extra actions per change.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/forms/StepUpPrompt.tsx
+++ b/packages/ui/src/forms/StepUpPrompt.tsx
@@
         <input
           aria-label={t("common.forms.step_up_code")}
           inputMode="numeric"
           autoComplete="one-time-code"
+          autoFocus
+          pattern="\d{6}"
           maxLength={6}
           className="erp-mono"
           value={code}
-          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
-          onKeyDown={(e) => e.key === "Enter" && ready && onConfirm(code)}
+          onChange={(e) => {
+            const next = e.target.value.replace(/\D/g, "").slice(0, 6);
+            setCode(next);
+            // The 6th digit (typed or pasted) sends the code: no extra Enter or click.
+            if (next.length === 6 && !busy) onConfirm(next);
+          }}
+          onKeyDown={(e) => {
+            if (e.key === "Enter" && ready) onConfirm(code);
+            if (e.key === "Escape") (e.preventDefault(), onCancel());
+          }}
         />
@@
       {error && (
         <span role="alert" className="erp-field__error">
           {t("common.forms.step_up_failed")}
         </span>
       )}
```
Also: when `error` changes to non-null, clear the box and refocus it (`useEffect(() => { if (error) { setCode(""); inputRef.current?.focus(); } }, [error])`), so a mistyped code is retyped straight away.

**Pure Tailwind & SVG Prototype Block**
```html
<div role="group" aria-label="Verificación en dos pasos" class="flex w-[420px] flex-col gap-1.5 rounded-md bg-warn-bg px-3 py-2.5 text-warn">
  <b>Verificación en dos pasos</b>
  <span class="text-xs">Escribe el código de 6 dígitos de tu app de autenticación. Se envía solo al completar el sexto dígito.</span>
  <div class="flex items-center gap-2">
    <input autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="Código de verificación" class="h-9 w-[136px] rounded-md border border-line-input bg-surface text-center font-mono text-base tracking-[6px] text-text outline-2 outline-offset-1 outline-focus-ring" value="4821">
    <button class="rounded-md bg-primary px-2.5 py-[5px] text-xs font-semibold text-white" disabled>Confirmar</button>
    <button class="rounded-md px-2.5 py-[5px] text-xs text-warn">Cancelar (Esc)</button>
  </div>
</div>
```

### 2.19 `packages/ui/src/attachments-panel.tsx`

**UX Friction Analysis**
- **The keyboard cannot add a file (H1).** The chooser is `<label className="erp-attachments__choose">…<input type="file" hidden /></label>` (`:237-247`). A `<label>` cannot take focus and a `hidden` input is `display:none`, so Tab never reaches it. The working tree's new rule `.erp-attachments__choose:focus-within` (components.css) can never match. The same pattern is in `record/PhotosTab.tsx:283-289` and `import/ImportDialog.tsx:190-201`. Rule 22 requires "drag-and-drop and chooser", and only the mouse gets both.
- **No paste.** Back-office users attach screenshots of RUT pages and bank certificates all day, and Ctrl+V does nothing.
- **Remove confirmation (`:326-335`).** It swaps the row for an `alertdialog` row without moving focus: the caret stays on a button that no longer exists and falls to `<body>`. Esc does not cancel. After removal, focus is lost again.
- **Upload progress is opaque (`:141-164`).** Files upload one by one, but only the button says "Subiendo…". With 6 staged files, the user cannot see which one is going or which one failed until the end.
- **Time zone and copy.** `uploadedAt.slice(0, 16).replace("T", " ")` (`:345`) prints UTC ("2026-10-28 15:04") for a company in America/Bogota. All other dates use `CellFormatProvider`. The labels default to Spanish literals (`attachments-model.ts:73-109`), see §2.20.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/attachments-panel.tsx
+++ b/packages/ui/src/attachments-panel.tsx
@@
-import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
+import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
+import { formatCellValue, useCellTimeZone } from "./grid/cell-format";
@@
   const [busy, setBusy] = useState(false);
+  const [uploadingKey, setUploadingKey] = useState<number | null>(null);
+  const fileInput = useRef<HTMLInputElement>(null);
+  const listHeading = useRef<HTMLHeadingElement>(null);
+  const timeZone = useCellTimeZone();
+  const when = (iso: string) => formatCellValue({ type: "datetime" }, iso, { yes: "", no: "", timeZone });
@@
+  // A screenshot or a copied file pasted anywhere in the panel is staged like a dropped one.
+  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
+    if (readOnly || !recordId || event.clipboardData.files.length === 0) return;
+    event.preventDefault();
+    stageFiles(Array.from(event.clipboardData.files));
+  };
@@ uploadAll
     for (const s of staged) {
+      setUploadingKey(s.key);
       const form = new FormData();
@@
     }
+    setUploadingKey(null);
     setStaged(left);
@@ remove
       if (!response.ok) throw new Error(await reasonOf(response));
       commit(items.filter((i) => i.id !== item.id));
+      listHeading.current?.focus();
@@
-    <div className={["erp-attachments", className].filter(Boolean).join(" ")}>
+    <div className={["erp-attachments", className].filter(Boolean).join(" ")} onPaste={onPaste}>
@@
             <div>
               <b>{labels.dropTitle}</b> {labels.dropOr}{" "}
-              <label className="erp-attachments__choose">
-                {labels.choose}
-                <input
-                  type="file"
-                  multiple
-                  hidden
-                  onChange={(event) => {
-                    stageFiles(Array.from(event.target.files ?? []));
-                    event.target.value = "";
-                  }}
-                />
-              </label>
+              {/* A real button: reachable with Tab, Enter/Space opens the system chooser. */}
+              <button type="button" className="erp-attachments__choose" onClick={() => fileInput.current?.click()}>
+                {labels.choose}
+              </button>
+              <input
+                ref={fileInput}
+                type="file"
+                multiple
+                hidden
+                tabIndex={-1}
+                onChange={(event) => {
+                  stageFiles(Array.from(event.target.files ?? []));
+                  event.target.value = "";
+                }}
+              />
             </div>
@@ staged row
-                <button type="button" aria-label={labels.unstage} onClick={() => setStaged((current) => current.filter((x) => x.key !== s.key))}>
+                <span className="erp-attachments__state" aria-live="polite">{uploadingKey === s.key ? labels.uploading : ""}</span>
+                <button type="button" aria-label={labels.unstage} disabled={busy} onClick={() => setStaged((current) => current.filter((x) => x.key !== s.key))}>
@@ list
-        <h3>
+        <h3 ref={listHeading} tabIndex={-1}>
           {labels.listTitle} <span className="erp-pill erp-pill--gray">{items.length}</span>
         </h3>
@@ confirm row
-              <div className="erp-attachments__row erp-attachments__row--confirm" role="alertdialog" aria-label={labels.confirmRemove(item.fileName, item.tag)} key={item.id}>
+              <div
+                className="erp-attachments__row erp-attachments__row--confirm"
+                role="alertdialog"
+                aria-label={labels.confirmRemove(item.fileName, item.tag)}
+                key={item.id}
+                onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setConfirming(null))}
+              >
                 <span className="erp-attachments__grow">{labels.confirmRemove(item.fileName, item.tag)}</span>
                 <button type="button" onClick={() => void remove(item)}>
                   {labels.confirmYes}
                 </button>
-                <button type="button" onClick={() => setConfirming(null)}>
+                {/* The safe answer takes the caret (a stray Enter keeps the file). */}
+                <button type="button" autoFocus onClick={() => setConfirming(null)}>
                   {labels.confirmNo}
                 </button>
@@ stored row
-                    {formatSize(item.sizeBytes)}
-                    {item.uploadedByName ? ` · ${item.uploadedByName}` : ""} · {item.uploadedAt.slice(0, 16).replace("T", " ")}
+                    {formatSize(item.sizeBytes)}
+                    {item.uploadedByName ? ` · ${item.uploadedByName}` : ""} · <time className="erp-attachments__when" dateTime={item.uploadedAt}>{when(item.uploadedAt)}</time>
```
The same chooser change applies to `record/PhotosTab.tsx:283-293` (`erp-photos__choose`).

**Pure Tailwind & SVG Prototype Block**: Archivos tab at 36 px rows: required checklist, drop zone with a real chooser button, staged files with per-row state, stored files.
```html
<div class="flex w-[860px] flex-col gap-4 rounded-lg border border-line bg-surface p-[18px] text-[13px] text-text">
  <section class="flex flex-col gap-2.5 border-b border-line-2 pb-3.5">
    <h3 class="m-0 text-xs font-bold tracking-[.04em] text-text-muted uppercase">Archivos definidos por el administrador</h3>
    <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
      <li class="flex min-h-7 items-center gap-1.5"><span class="rounded-[4px] bg-ok-bg px-2 py-0.5 text-xs text-ok">cargado</span><b>RUT</b><span class="text-xs text-text-muted">PDF · vigente del año</span></li>
      <li class="flex min-h-7 items-center gap-1.5"><span class="rounded-[4px] bg-danger-bg px-2 py-0.5 text-xs text-danger">obligatorio</span><b>Certificación bancaria</b><span class="text-xs text-text-muted">PDF</span></li>
    </ul>
    <p class="m-0 rounded-md bg-warn-bg px-2.5 py-2 text-xs text-warn">Mientras falte Certificación bancaria el registro no se puede usar en facturas.</p>
  </section>
  <div class="flex flex-col items-center gap-1.5 rounded-lg border-2 border-dashed border-line bg-head p-[18px] text-center text-text-muted focus-within:border-focus-ring">
    <div><b class="text-text">Arrastra los archivos aquí</b> o <button type="button" class="font-semibold text-primary underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">elígelos</button> · o pégalos con Ctrl+V</div>
    <div class="text-xs">Cualquier tipo · hasta 25 MB por archivo · descarga con URL firmada de 60 s</div>
  </div>
  <section class="flex flex-col gap-2.5 border-b border-line-2 pb-3.5">
    <h3 class="m-0 text-xs font-bold tracking-[.04em] text-text-muted uppercase">Por subir · asigna la etiqueta de cada archivo</h3>
    <div class="flex min-h-9 items-center gap-2.5 border-b border-dashed border-line-2 py-1.5">
      <span class="w-6 text-center text-lg" aria-hidden="true">📄</span>
      <div class="min-w-0 flex-1"><div class="truncate">certificacion-bancolombia.pdf</div><div class="text-xs text-text-muted">184 KB</div></div>
      <select class="w-[200px] rounded-md border border-line-input bg-surface px-2 py-1.5"><option>Certificación bancaria</option></select>
      <span class="w-24 text-right text-xs text-text-muted" aria-live="polite">Subiendo…</span>
      <button class="min-h-8 rounded-md border border-line px-3" disabled aria-label="Quitar de la lista">✕</button>
    </div>
    <div class="flex min-h-9 items-center gap-2.5"><span class="grow text-xs text-text-muted">Listo para subir</span><button class="min-h-8 rounded-md bg-primary px-3 font-semibold text-white" disabled>Subiendo…</button></div>
  </section>
  <section class="flex flex-col gap-2.5">
    <h3 tabindex="-1" class="m-0 text-xs font-bold tracking-[.04em] text-text-muted uppercase">Archivos adjuntos <span class="rounded-[4px] bg-line-2 px-2 py-0.5 normal-case">2</span></h3>
    <div class="flex min-h-9 items-center gap-2.5 border-b border-dashed border-line-2 py-1.5">
      <span class="w-6 text-center text-lg" aria-hidden="true">📄</span>
      <div class="min-w-0 flex-1"><div class="truncate"><span class="rounded-[4px] bg-info-bg px-2 py-0.5 text-xs text-info">RUT</span> rut-cafe-del-norte-2026.pdf</div><div class="text-xs text-text-muted">412 KB · Laura Gómez · <time class="font-mono text-[11px]" datetime="2026-10-28T15:04:00Z">28/10/26, 10:04</time></div></div>
      <button class="min-h-8 rounded-md border border-line px-3">Descargar</button><button class="min-h-8 rounded-md border border-line px-3" aria-label="Quitar rut-cafe-del-norte-2026.pdf">✕</button>
    </div>
    <div role="alertdialog" aria-label="¿Quitar foto-fachada.jpg (Otro)?" class="flex min-h-9 items-center gap-2.5 rounded-md bg-danger-bg px-2.5 py-1.5 text-danger">
      <span class="grow">¿Quitar foto-fachada.jpg (Otro)? Deja de estar disponible pero queda en auditoría.</span>
      <button class="min-h-8 rounded-md bg-danger px-3 font-semibold text-white">Sí, quitar</button>
      <button autofocus class="min-h-8 rounded-md border border-line bg-surface px-3 text-text outline-2 outline-offset-1 outline-focus-ring">No</button>
    </div>
  </section>
</div>
```

### 2.20 `apps/web/src/app/(app)/r/[entity]/[id]/files-panel.tsx`

**UX Friction Analysis**
- `AttachmentsPanel` is mounted without `labels` (`:25-33`), so it uses `DEFAULT_LABELS`, the Spanish literals in `packages/ui/src/attachments-model.ts:73-109`. The catalogue already has every key under `common.attachments.*` (es-419 and en), but nothing reads it. An `en` user gets a Spanish Archivos tab, which breaks rule 24. `missing()` also joins tags with a literal " y ".

**Proposed Code Diff**
```diff
--- a/apps/web/src/app/(app)/r/[entity]/[id]/files-panel.tsx
+++ b/apps/web/src/app/(app)/r/[entity]/[id]/files-panel.tsx
@@
-import { useRouter } from "next/navigation";
-import { AttachmentsPanel, type AttachmentItem, type RequiredTag } from "@erp/ui";
+import { useMemo } from "react";
+import { useRouter } from "next/navigation";
+import { useLocale, useTranslations } from "next-intl";
+import { AttachmentsPanel, type AttachmentItem, type AttachmentsLabels, type RequiredTag } from "@erp/ui";
@@
 export function FilesPanel({ entity, recordId, requiredTags, attachments, can }: FilesPanelProps) {
   const router = useRouter();
+  const t = useTranslations("common.attachments");
+  const locale = useLocale();
+  // The panel's copy from the catalogue (rule 24); lists joined the locale's way ("RUT y Cámara", "RUT and Chamber").
+  const labels = useMemo<AttachmentsLabels>(() => {
+    const list = new Intl.ListFormat(locale, { type: "conjunction" });
+    return {
+      requiredTitle: t("required_title"), loaded: t("loaded"), required: t("required"), optional: t("optional"),
+      kindPdf: t("kind_pdf"), kindImage: t("kind_image"), kindAny: t("kind_any"),
+      missing: (tags) => t("missing", { tags: list.format(tags) }),
+      saveFirst: t("save_first"), dropTitle: t("drop_title"), dropOr: t("drop_or"), choose: t("choose"), dropHint: t("drop_hint"),
+      stageTitle: t("stage_title"), tagPlaceholder: t("tag_placeholder"), tagOther: t("tag_other"), tagName: t("tag_name"),
+      unstage: t("unstage"), readyToUpload: t("ready_to_upload"), needsTag: t("needs_tag"),
+      upload: (count) => t("upload", { count }), uploading: t("uploading"), listTitle: t("list_title"), empty: t("empty"),
+      download: t("download"), remove: (name) => t("remove", { name }), confirmRemove: (name, tag) => t("confirm_remove", { name, tag }),
+      confirmYes: t("confirm_yes"), confirmNo: t("confirm_no"), tooBig: (name) => t("too_big", { name }), duplicate: (name) => t("duplicate", { name }),
+      wrongKind: (tag, kind) => t(kind === "pdf" ? "wrong_kind_pdf" : "wrong_kind_image", { tag }),
+      failed: (name, reason) => t("failed", { name, reason }), actionFailed: (reason) => t("action_failed", { reason }), loadFailed: t("load_failed"),
+    };
+  }, [t, locale]);
   return (
     <AttachmentsPanel
       entity={entity}
       recordId={recordId}
+      labels={labels}
```
(The `reason` passed to `failed`/`actionFailed` is still the API's raw code, for example `file_too_large`. Translate it with `errors.<code>` before formatting. `PhotosPanel` and `ContactsPanel` need the same check.)

**Pure Tailwind & SVG Prototype Block**: the same tab in `en`, to compare with the es-419 block above.
```html
<div lang="en" class="flex w-[860px] flex-col gap-2 rounded-lg border border-line bg-surface p-[18px] text-[13px]">
  <h3 class="m-0 text-xs font-bold tracking-[.04em] text-text-muted uppercase">Files required by the administrator</h3>
  <p class="m-0 rounded-md bg-warn-bg px-2.5 py-2 text-xs text-warn">While Bank certificate and Chamber of commerce are missing, the record cannot be used on invoices.</p>
  <div class="rounded-lg border-2 border-dashed border-line bg-head p-[18px] text-center text-text-muted"><b class="text-text">Drop files here</b> or <button class="font-semibold text-primary underline">choose them</button></div>
</div>
```

### 2.21 `packages/ui/src/record/RecordFrame.tsx`

**UX Friction Analysis**
- Record tabs get ← → roving (`:45-51`), which is good, but not Home/End (WAI-ARIA tabs pattern, L3), and there is no shortcut to jump between Datos and Archivos while typing.
- `.erp-record__tab` has no focus rule. It inherits the 50 % base ring (1.33:1), which disappears against the active tab's primary underline.
- The record header (`:55-63`) sits in normal flow. On a 1,400 px tall party form, the title, N.º and the open-in-new-tab link scroll away, so the user loses which record is open while typing in the Commercial section.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/record/RecordFrame.tsx
+++ b/packages/ui/src/record/RecordFrame.tsx
@@
   const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
-    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
-    if (step === 0 || tabs.length === 0) return;
+    if (tabs.length === 0) return;
+    const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : -1;
+    if (target < 0) return;
     event.preventDefault();
-    select(tabs[(index + step + tabs.length) % tabs.length]!.id);
-    document.getElementById(`${base}-tab-${tabs[(index + step + tabs.length) % tabs.length]!.id}`)?.focus();
+    select(tabs[target]!.id);
+    document.getElementById(`${base}-tab-${tabs[target]!.id}`)?.focus();
   };
@@
-    <section className={["erp-record", className].filter(Boolean).join(" ")}>
-      <header className="erp-record__header">
+    <section className={["erp-record", className].filter(Boolean).join(" ")}>
+      {/* Title and tabs stay in view while the Datos form scrolls (the shell's <main> is the scroller). */}
+      <div className="sticky top-0 z-[5] rounded-t-lg bg-surface">
+      <header className="erp-record__header">
@@
       </div>
+      </div>
```
CSS: `.erp-record__tab:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: 4px; }`.

**Pure Tailwind & SVG Prototype Block**
```html
<section class="flex h-[300px] w-[900px] flex-col overflow-auto rounded-lg border border-line bg-surface">
  <div class="sticky top-0 z-[5] bg-surface">
    <header class="flex items-center gap-2.5 border-b border-line-2 px-[18px] py-3"><h2 class="m-0 grow text-[15px] font-bold">Café del Norte S.A.S.</h2><span class="font-mono text-xs text-text-muted">N.º 17 · uuid 0192f3a1…</span><a class="text-xs text-primary" href="#">Abrir en una pestaña nueva ↗</a></header>
    <div role="tablist" class="flex gap-0.5 border-b border-line px-[18px]">
      <button role="tab" aria-selected="true" class="-mb-px border-b-2 border-primary px-3 py-2.5 text-[13px] font-semibold text-primary">Datos</button>
      <button role="tab" tabindex="-1" class="-mb-px border-b-2 border-transparent px-3 py-2.5 text-[13px] text-text-muted">Contactos <span class="rounded-lg bg-line-2 px-1.5 text-[11px]">2</span></button>
      <button role="tab" tabindex="-1" class="-mb-px rounded border-b-2 border-transparent px-3 py-2.5 text-[13px] text-text-muted outline-2 -outline-offset-2 outline-focus-ring">Archivos <span class="rounded-lg bg-warn-bg px-1.5 text-[11px] text-warn">1</span></button>
    </div>
  </div>
  <div class="p-[18px] text-[13px] text-text-muted">… contenido del formulario (desplázate: el encabezado y las pestañas quedan visibles) …<div class="h-[600px]"></div></div>
</section>
```

### 2.22 `packages/ui/src/assistant/AssistantDrawer.tsx`

**UX Friction Analysis**
- The header (`:65-78`) has no live state. While a turn streams, the only cue is three dots at the bottom of the log, which disappear as soon as the first token or tool part arrives (`MessageList.tsx:132`). After that, a long tool call ("kernel.data.query" over 10k rows) looks frozen. Neither "Respondiendo" nor "Listo" is ever shown or announced.
- The drawer is `hidden` when closed (`:64`), which is right, but it has no `id` for the top-bar toggle's `aria-controls`.
- "Nueva conversación" mounts only once the log has messages (`:72-76`), which shifts the context line. That is minor.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/assistant/AssistantDrawer.tsx
+++ b/packages/ui/src/assistant/AssistantDrawer.tsx
@@
   return (
-    <aside aria-label={t("assistant")} hidden={!open} className="flex min-h-0 w-[400px] shrink-0 flex-col border-l border-line bg-surface">
-      <div className="flex items-center justify-between gap-2 border-b border-line-2 px-4 py-3">
+    <aside id="erp-assistant" data-assistant aria-label={t("assistant")} hidden={!open} className="flex min-h-0 w-[400px] shrink-0 flex-col border-l border-line bg-surface">
+      <div className="flex h-[45px] shrink-0 items-center justify-between gap-2 border-b border-line-2 px-4">
         <div className="flex items-center gap-2 font-bold">
           <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-primary" />
           {t("assistant")}
         </div>
         <div className="flex min-w-0 items-center gap-2">
+          {/* Fixed slot: the pill shows while a turn streams and keeps its width when idle; the sr-only status says it once. */}
+          <span aria-hidden="true" className="erp-live" style={{ visibility: assistant.working ? "visible" : "hidden" }}>
+            <i />
+            {tAgent("answering")}
+          </span>
+          <span role="status" className="sr-only">
+            {assistant.working ? tAgent("answering") : assistant.messages.length > 0 ? tAgent("answer_ready") : ""}
+          </span>
           <div className="truncate text-xs text-text-muted">{t("drawer.context", { context })}</div>
-          {!empty && (
-            <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm" onClick={assistant.newConversation}>
-              {tAgent("new_conversation")}
-            </button>
-          )}
+          <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm" disabled={empty} onClick={assistant.newConversation}>
+            {tAgent("new_conversation")}
+          </button>
         </div>
       </div>
```

**Pure Tailwind & SVG Prototype Block**: the header alone here; §2.23 draws the whole drawer.

```html
<div class="flex h-[45px] w-[400px] items-center justify-between gap-2 border-b border-line-2 bg-surface px-4">
  <div class="flex items-center gap-2 font-bold"><span class="inline-block size-2.5 rounded-full bg-primary"></span>Asistente</div>
  <div class="flex min-w-0 items-center gap-2">
    <span role="status" class="inline-flex h-5 items-center gap-1.5 rounded-full border border-line-2 bg-head px-2 text-xs text-text-muted"><i class="size-2 rounded-full bg-ok"></i>Respondiendo…</span>
    <span class="truncate text-xs text-text-muted">Viendo: Terceros</span>
    <button class="rounded-md px-2 py-1 text-xs text-text-muted">Nueva conversación</button>
  </div>
</div>
```

### 2.23 `packages/ui/src/assistant/MessageList.tsx`

**UX Friction Analysis**
- **Scroll is hijacked (H6).** `useEffect(() => { el.scrollTop = el.scrollHeight }, [messages, working])` (`:46-49`) runs on every streamed delta. A user who scrolls up to re-read a result table or a confirmation card is pulled to the bottom 10 to 30 times a second until the turn ends. Reading while streaming is impossible.
- **Screen-reader flood.** `role="log" aria-live="polite"` (`:120`) on the whole conversation announces every text delta as it lands. A 400-word answer is read in hundreds of fragments.
- **Layout shift.** The typing row (`:132-139`) mounts and unmounts between text and tool parts, so the log jumps by 18 px each time.
- **Long conversations.** They re-render and lay out every bubble on each delta. The CSS has no `content-visibility`.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/assistant/MessageList.tsx
+++ b/packages/ui/src/assistant/MessageList.tsx
@@
-import { useEffect, useRef } from "react";
+import { useLayoutEffect, useRef, useState } from "react";
@@
   const t = useTranslations();
   const log = useRef<HTMLDivElement>(null);
-  useEffect(() => {
-    const el = log.current;
-    if (el) el.scrollTop = el.scrollHeight;
-  }, [messages, working]);
+  // Stick to the bottom only while the reader is there (within 48 px); scrolling up to read stops the follow, and a
+  // "Ir al final" button brings it back. A message the user just sent always follows.
+  const pinned = useRef(true);
+  const [away, setAway] = useState(false);
+  const onScroll = () => {
+    const el = log.current;
+    if (!el) return;
+    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
+    pinned.current = atEnd;
+    if (atEnd === away) setAway(!atEnd);
+  };
+  useLayoutEffect(() => {
+    const el = log.current;
+    if (!el) return;
+    if (messages.at(-1)?.role === "user") pinned.current = true;
+    if (pinned.current) el.scrollTop = el.scrollHeight;
+  }, [messages, working]);
+  const jump = () => {
+    pinned.current = true;
+    setAway(false);
+    log.current?.scrollTo({ top: log.current.scrollHeight });
+  };
@@
   return (
-    <div ref={log} className="erp-chat__log" role="log" aria-live="polite">
+    // aria-busy holds announcements while a turn streams; the finished message is read once (WAI-ARIA live regions).
+    <div ref={log} className="erp-chat__log" role="log" aria-live="polite" aria-relevant="additions" aria-busy={working} onScroll={onScroll}>
@@
-      {working && !answering(messages) && (
-        <div className="erp-typing" role="status">
-          <i />
-          <i />
-          <i />
-          <span>{t("agent.thinking")}</span>
-        </div>
-      )}
+      {/* Always laid out (18 px): thinking dots before the first token, nothing after; the log never jumps. */}
+      <div className="erp-chat__status" aria-hidden="true">
+        {working && !answering(messages) && (
+          <span className="erp-typing">
+            <i />
+            <i />
+            <i />
+            <span>{t("agent.thinking")}</span>
+          </span>
+        )}
+      </div>
+      {away && (
+        <button type="button" className="erp-btn erp-btn--sm erp-chat__jump" onClick={jump}>
+          {t("agent.ui.jump_latest")} ↓
+        </button>
+      )}
     </div>
   );
```
Tool parts in `input-streaming` (`:54-59`) should render the running line inside a fixed 18 px box too (`<div className="erp-chat__tool" style={{ minHeight: 18 }}>`), so that the result table replaces it without a jump: give `.erp-result__scroll` a `min-height: 120px` while `rows.length > 0`.

**Pure Tailwind & SVG Prototype Block**: the 400 px drawer mid-stream, scrolled up, with the jump button, the result table (tabular, masked), and the step-up confirmation card.
```html
<aside class="flex h-[640px] w-[400px] flex-col border-l border-line bg-surface text-sm" aria-label="Asistente">
  <div class="flex h-[45px] shrink-0 items-center justify-between gap-2 border-b border-line-2 px-4">
    <div class="flex items-center gap-2 font-bold"><span class="inline-block size-2.5 rounded-full bg-primary"></span>Asistente</div>
    <span role="status" class="inline-flex h-5 items-center gap-1.5 rounded-full border border-line-2 bg-head px-2 text-xs text-text-muted"><i class="size-2 rounded-full bg-ok"></i>Respondiendo…</span>
  </div>
  <div role="log" aria-live="polite" aria-busy="true" class="relative flex min-h-0 flex-1 flex-col gap-3 overflow-auto overscroll-contain p-4 leading-normal [overflow-anchor:none]">
    <div class="max-w-[88%] self-end rounded-[10px_10px_2px_10px] bg-primary px-3 py-2.5 text-white">Clientes de Antioquia con cupo mayor a 10 millones</div>
    <div class="flex max-w-[96%] flex-col gap-2 rounded-[10px_10px_10px_2px] bg-head px-3 py-2.5">
      <p class="m-0">Encontré 3 clientes:</p>
      <div class="max-h-[280px] overflow-auto rounded-md border border-line-2 bg-surface">
        <table class="w-full border-collapse text-[13px]">
          <thead><tr><th class="sticky top-0 border-b border-line bg-head px-2.5 py-1.5 text-left text-xs text-text-muted">Razón social</th><th class="sticky top-0 border-b border-line bg-head px-2.5 py-1.5 text-right text-xs text-text-muted">Cupo</th><th class="sticky top-0 border-b border-line bg-head px-2.5 py-1.5 text-right text-xs text-text-muted">Saldo</th></tr></thead>
          <tbody>
            <tr><td class="h-[30px] border-b border-line-2 px-2.5 whitespace-nowrap">Tostadora Antioquia</td><td class="h-[30px] border-b border-line-2 px-2.5 text-right tabular-nums">$ 25.000.000,00</td><td class="h-[30px] border-b border-line-2 px-2.5 text-right tracking-[1px] text-text-muted" title="Valor enmascarado">••••••</td></tr>
            <tr><td class="h-[30px] border-b border-line-2 px-2.5 whitespace-nowrap">Café del Valle</td><td class="h-[30px] border-b border-line-2 px-2.5 text-right tabular-nums">$ 12.500.000,00</td><td class="h-[30px] border-b border-line-2 px-2.5 text-right tracking-[1px] text-text-muted">••••••</td></tr>
          </tbody>
        </table>
      </div>
      <div class="text-xs text-text-muted">3 de 3</div>
      <div class="flex flex-wrap gap-1.5"><button class="rounded-md border border-line bg-surface px-2.5 py-[5px] text-xs">Abrir como grid</button><button class="rounded-md border border-line bg-surface px-2.5 py-[5px] text-xs">Excel</button></div>
    </div>
    <article class="overflow-hidden rounded-lg border border-line bg-surface" aria-label="Actualizar cupo de Café del Valle">
      <div class="border-b border-warn-bg bg-warn-bg px-3 py-[9px] text-[13px] font-semibold text-warn">Actualizar cupo de Café del Valle</div>
      <dl class="m-0 flex flex-col gap-1 border-b border-line-2 px-3 py-2.5 text-[13px] text-text-muted">
        <div class="flex items-baseline justify-between gap-3"><dt>Cupo</dt><dd class="m-0 text-right text-text tabular-nums">$ 12.500.000,00 → $ 15.000.000,00</dd></div>
        <div class="flex items-baseline justify-between gap-3"><dt>Permiso</dt><dd class="m-0 text-right font-mono text-xs text-text">core.party.update · con verificación</dd></div>
      </dl>
      <div class="flex flex-col gap-1.5 border-b border-line-2 px-3 py-2.5" role="group" aria-label="Verificación en dos pasos">
        <span class="text-xs text-text-muted">Código de 6 dígitos (se verifica solo)</span>
        <div class="flex items-center gap-2"><input class="h-9 w-[136px] rounded-md border border-line-input bg-surface text-center font-mono text-base tracking-[6px] text-text" value="482193" aria-label="Código"><span class="rounded-[4px] bg-ok-bg px-2 py-0.5 text-xs text-ok">✓ Verificado</span></div>
      </div>
      <div class="flex flex-wrap items-center gap-2 px-3 py-2.5"><button class="rounded-md bg-primary px-3 py-[7px] text-[13px] font-semibold text-white outline-2 outline-offset-1 outline-focus-ring">Confirmar</button><button class="rounded-md border border-line px-3 py-[7px] text-[13px]">Editar</button><button class="rounded-md border border-line px-3 py-[7px] text-[13px]">Cancelar</button></div>
    </article>
    <div class="flex h-[18px] shrink-0 items-center gap-1.5 text-xs text-text-muted" aria-hidden="true"></div>
    <button class="sticky bottom-0 z-10 self-center rounded-md border border-line bg-surface px-2.5 py-[5px] text-xs shadow-[0_4px_12px_var(--shadow)]">Ir al final ↓</button>
  </div>
  <div class="flex gap-2 border-t border-line-2 p-3">
    <textarea rows="1" class="max-h-[132px] min-h-[38px] min-w-0 flex-1 resize-none rounded-md border border-line-input bg-surface px-3 py-[9px] text-[13px] leading-snug text-text [field-sizing:content]" placeholder="Pregunta o pide algo… (Shift+Enter: nueva línea)"></textarea>
    <button class="grid w-10 place-items-center rounded-md border border-line bg-surface" aria-label="Detener (Esc)">■</button>
  </div>
</aside>
```

### 2.24 `packages/ui/src/assistant/Composer.tsx`

**UX Friction Analysis**
- A single-line `<input>` (`:30-41`) for prompts that are often 2–3 lines ("Crea el tercero… con NIT… en Medellín, cupo…"). There is no Shift+Enter, and long prompts scroll horizontally out of sight, so mistakes in them go unnoticed.
- Esc does not stop a running turn. The ■ button (`:43-45`) is the only stop.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/assistant/Composer.tsx
+++ b/packages/ui/src/assistant/Composer.tsx
@@
-      <input
+      <textarea
         id="erp-assistant-input"
+        rows={1}
         value={draft}
         disabled={disabled}
         maxLength={4000}
+        aria-keyshortcuts="Enter Shift+Enter Escape"
         onChange={(event) => setDraft(event.target.value)}
         onKeyDown={(event) => {
-          if (event.key === "Enter" && !event.nativeEvent.isComposing) send();
+          if (event.nativeEvent.isComposing) return;
+          // Enter sends, Shift+Enter breaks the line, Esc stops a running answer.
+          if (event.key === "Enter" && !event.shiftKey) {
+            event.preventDefault();
+            send();
+          } else if (event.key === "Escape" && working) {
+            event.preventDefault();
+            onStop?.();
+          }
         }}
         placeholder={t("drawer.input")}
-        className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2.5 text-[13px] text-text outline-none focus:outline-2 focus:outline-focus disabled:opacity-60"
+        className="disabled:opacity-60"
       />
```
(Sizing comes from `.erp-chat__input textarea` in §2.3: `field-sizing: content` with a 132 px cap. Older engines keep one line and scroll inside, which is still better than the input.)

**Pure Tailwind & SVG Prototype Block**
```html
<div class="flex w-[400px] gap-2 border-t border-line-2 bg-surface p-3">
  <textarea rows="3" class="max-h-[132px] min-h-[38px] min-w-0 flex-1 resize-none rounded-md border border-line-input bg-surface px-3 py-[9px] text-[13px] leading-snug text-text outline-2 outline-offset-1 outline-focus-ring" aria-keyshortcuts="Enter Shift+Enter Escape">Crea el tercero Tostadora Antioquia S.A.S., NIT 900111222,
en Medellín, cliente, cupo 25 millones</textarea>
  <button class="grid w-10 place-items-center self-end rounded-md bg-primary py-2.5 font-semibold text-white" aria-label="Enviar">↑</button>
</div>
```

### 2.25 `packages/ui/src/assistant/ConfirmationCard.tsx`

**UX Friction Analysis**
- After the code is verified, the caret stays in the code box (`:85` → `StepUpField`). The user Tabs past "Verificar" to reach "Confirmar", which is disabled until then (`:111`). Nothing moves focus.
- Effect values (`:75`) are free text: amounts and ids align right (`components.css:261`) but in proportional figures, so "$ 12.500.000,00 → $ 15.000.000,00" misaligns between rows (L7). The permission line mixes a process id with prose.
- In edit mode (`:92-108`), Esc does not go back, and the first input does not get focus.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/assistant/ConfirmationCard.tsx
+++ b/packages/ui/src/assistant/ConfirmationCard.tsx
@@
-import { useId, useState } from "react";
+import { useEffect, useId, useRef, useState } from "react";
@@
   const [draft, setDraft] = useState<string[]>(() => preview.effects.map((e) => e.value));
+  const confirmRef = useRef<HTMLButtonElement>(null);
+  // A verified code makes Confirmar the next step: the caret goes there (Enter confirms).
+  useEffect(() => {
+    if (token) confirmRef.current?.focus();
+  }, [token]);
@@
-      <dl className="erp-confirm__body">
+      <dl className="erp-confirm__body" onKeyDown={(e) => editing && e.key === "Escape" && (e.stopPropagation(), setEditing(false))}>
@@
-                <input id={`${id}-${i}`} value={draft[i] ?? ""} onChange={(event) => setDraft((d) => d.map((v, j) => (j === i ? event.target.value : v)))} />
+                <input id={`${id}-${i}`} autoFocus={i === 0} value={draft[i] ?? ""} onChange={(event) => setDraft((d) => d.map((v, j) => (j === i ? event.target.value : v)))} />
@@
         <div>
           <dt>{t("agent.ui.card.permission")}</dt>
-          <dd>{permission}</dd>
+          <dd>
+            <span className="erp-mono erp-small">{preview.permission}</span> · {t(preview.stepUp ? "agent.ui.card.with_step_up" : "agent.ui.card.without_step_up")}
+          </dd>
         </div>
@@
-            <button type="button" className="erp-btn erp-btn--primary" disabled={busy || needsToken} onClick={confirm}>
+            <button ref={confirmRef} type="button" className="erp-btn erp-btn--primary" disabled={busy || needsToken} onClick={confirm}>
```
(`permission` becomes unused and is dropped.)

**Pure Tailwind & SVG Prototype Block**: the card in its three states: pending, executed, rejected.
```html
<div class="flex w-[368px] flex-col gap-3 text-[13px]">
  <article class="overflow-hidden rounded-lg border border-line bg-surface"><div class="border-b border-accent-line bg-accent px-3 py-[9px] font-semibold">Crear tercero Tostadora Antioquia S.A.S.</div>
    <dl class="m-0 flex flex-col gap-1 border-b border-line-2 px-3 py-2.5 text-text-muted"><div class="flex justify-between gap-3"><dt>NIT</dt><dd class="m-0 font-mono text-text tabular-nums">900111222-3</dd></div><div class="flex justify-between gap-3"><dt>Cupo</dt><dd class="m-0 text-text tabular-nums">$ 25.000.000,00</dd></div><div class="flex justify-between gap-3"><dt>Permiso</dt><dd class="m-0 text-text"><span class="font-mono text-xs">core.party.create</span> · sin verificación</dd></div></dl>
    <div class="flex gap-2 px-3 py-2.5"><button class="rounded-md bg-primary px-3 py-[7px] font-semibold text-white">Confirmar</button><button class="rounded-md border border-line px-3 py-[7px]">Editar</button><button class="rounded-md border border-line px-3 py-[7px]">Cancelar</button></div></article>
  <article class="overflow-hidden rounded-lg border border-line bg-surface"><div class="bg-ok-bg px-3 py-[9px] font-semibold text-ok">✓ Crear tercero Tostadora Antioquia S.A.S.</div><div class="px-3 py-2.5 text-xs text-text-muted">Hecho · N.º 483</div></article>
  <article class="overflow-hidden rounded-lg border border-line bg-surface"><div class="bg-line-2 px-3 py-[9px] font-semibold text-text-muted">✕ Actualizar cupo de Café del Valle</div><div class="px-3 py-2.5 text-xs text-text-muted">Cancelado por ti</div></article>
</div>
```

### 2.26 `packages/ui/src/assistant/StepUpField.tsx`

**UX Friction Analysis**
- The code box (`:56-74`) never takes focus when the card appears, and needs Enter or "Verificar" after the 6th digit. A pasted code from an authenticator app also needs a click.
- The input has no focus rule (`.erp-confirm__stepup input`, `components.css:266`). It inherits the faint 50 % ring.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/assistant/StepUpField.tsx
+++ b/packages/ui/src/assistant/StepUpField.tsx
@@
-import { useState } from "react";
+import { useEffect, useRef, useState } from "react";
@@
   const ready = /^\d{6}$/.test(code);
+  const input = useRef<HTMLInputElement>(null);
+  // Take the caret only when the user is not typing elsewhere (the composer, or nothing focused): never steal it from a form.
+  useEffect(() => {
+    const active = document.activeElement;
+    if (!active || active === document.body || active.closest("[data-assistant]")) input.current?.focus();
+  }, []);
 
-  const verify = async () => {
-    if (!ready || busy || verified) return;
+  const verify = async (value = code) => {
+    if (!/^\d{6}$/.test(value) || busy || verified) return;
@@
-      const response = await (fetcher ?? fetch)(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
+      const response = await (fetcher ?? fetch)(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: value }) });
@@
         <input
+          ref={input}
           aria-label={t("agent.step_up_code")}
@@
           onChange={(event) => {
-            setCode(event.target.value.replace(/\D/g, ""));
+            const next = event.target.value.replace(/\D/g, "").slice(0, 6);
+            setCode(next);
             if (verified) {
               setVerified(false);
               onToken(null);
             }
+            // The 6th digit verifies: typed or pasted, no extra key.
+            if (next.length === 6) void verify(next);
           }}
```

**Pure Tailwind & SVG Prototype Block**
```html
<div role="group" aria-label="Verificación en dos pasos" class="flex w-[368px] flex-col gap-1.5 border-b border-line-2 bg-surface px-3 py-2.5">
  <span class="text-xs text-text-muted">Esta acción es sensible: escribe el código de tu app (se verifica al sexto dígito).</span>
  <div class="flex items-center gap-2">
    <input autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="Código de verificación" class="h-9 w-[136px] rounded-md border border-line-input bg-surface text-center font-mono text-base tracking-[6px] text-text outline-2 outline-offset-1 outline-focus-ring" value="48219">
    <button class="rounded-md border border-line px-2.5 py-[5px] text-xs" disabled>Verificar</button>
  </div>
  <span role="alert" class="text-[11px] font-semibold text-danger">Código incorrecto. Intenta de nuevo.</span>
</div>
```

### 2.27 `packages/ui/src/home/KpiCard.tsx`

**UX Friction Analysis**
- A KPI is a bare number (`:22-24`) with no direction and no age. "482 terceros" says nothing about whether entry is keeping pace. The home is a server snapshot (`app/(app)/page.tsx:19`), yet nothing says when it was taken. After an 8-hour shift the tab still shows the 8 a.m. numbers as if they were current.
- The share bar (`:25-37`) is an 8 px `div` with `role="progressbar"`, which is the wrong role: a share of a total is a meter. It has no thresholds, and the warn tone colours only the number (`data-tone`, `components.css:326`), so the cue is colour-only.
- The value is 26 px/700 in a 14–16 px padded cell (`components.css:322-325`). That is good. The 4-up strip (`erp-home-kpis`) is already dense, so the space for a trend line comes from the 8 px detail margin (`components.css:327`).

**Proposed Code Diff**: zero-dependency SVG. Trend and "as of" need optional fields on the kernel `Kpi` contract (OWNER DECISION OD-9; providers compute the series in SQL, rule 29).
```diff
--- a/packages/kernel/src/registry/types.ts
+++ b/packages/kernel/src/registry/types.ts
@@ export interface Kpi {
   detail?: { key: string; params: Record<string, string | number> };
+  /** OD-9: oldest → newest values of the same measure (e.g. the last 14 days), for the trend line. */
+  series?: number[];
 }
```
```tsx
// packages/ui/src/home/Sparkline.tsx (new) — a trend line drawn to scale in the card's width, colours from the tokens.
export function Sparkline({ values, label, height = 28 }: { values: readonly number[]; label: string; height?: number }) {
  if (values.length < 2) return null;
  const width = 120; // viewBox units; the SVG stretches to the card, strokes stay 1.5 px (non-scaling).
  const pad = 2;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const x = (i: number) => ((i * width) / (values.length - 1)).toFixed(2);
  const y = (v: number) => (height - pad - ((v - min) / span) * (height - 2 * pad)).toFixed(2);
  const line = values.map((v, i) => `${x(i)},${y(v)}`).join(" L");
  return (
    <svg className="erp-home-kpi__trend" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={`M0,${height} L${line} L${width},${height} Z`} fill="var(--accent)" />
      <path d={`M${line}`} fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A share against its allowance: track, fill, an 80 % tick; warn from 80 %, danger at 100 % (and the number says it). */
export function ShareMeter({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(1, value));
  const fill = pct >= 1 ? "var(--danger)" : pct >= 0.8 ? "var(--warn)" : "var(--primary)";
  return (
    <svg className="erp-meter" viewBox="0 0 100 22" preserveAspectRatio="none" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
      <rect x="0" y="8" width="100" height="6" rx="3" fill="var(--line-2)" />
      <rect x="0" y="8" width={pct * 100} height="6" rx="3" fill={fill} />
      <line x1="80" x2="80" y1="4" y2="18" stroke="var(--text-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
```
```diff
--- a/packages/ui/src/home/KpiCard.tsx
+++ b/packages/ui/src/home/KpiCard.tsx
@@
 import { detailParams, formatCompact, formatCount } from "./format";
+import { ShareMeter, Sparkline } from "./Sparkline";
@@
       <div className="erp-home-kpi__value" data-testid="kpi-value" data-tone={kpi.tone ?? "default"}>
         {value}
+        {kpi.tone === "warn" && <span className="erp-pill erp-pill--warn" style={{ marginLeft: 8, verticalAlign: "middle", fontSize: 11 }}>{t("home.kpi.attention")}</span>}
       </div>
-      {kpi.progress !== undefined ? (
-        <div
-          className="erp-bar"
-          style={{ marginTop: 8, height: 6 }}
-          role="progressbar"
-          aria-label={t(kpi.label)}
-          aria-valuemin={0}
-          aria-valuemax={100}
-          aria-valuenow={Math.round(kpi.progress * 100)}
-        >
-          <i style={{ width: `${Math.round(kpi.progress * 100)}%` }} />
-        </div>
-      ) : null}
+      {kpi.progress !== undefined && <ShareMeter value={kpi.progress} label={`${t(kpi.label)} · ${Math.round(kpi.progress * 100)} %`} />}
+      {kpi.series && kpi.series.length > 1 && <Sparkline values={kpi.series} label={t("home.kpi.trend", { days: kpi.series.length })} />}
       {kpi.detail ? <div className="erp-home-kpi__detail">{t(kpi.detail.key, detailParams(locale, kpi.detail.params))}</div> : null}
```

**Pure Tailwind & SVG Prototype Block**: KPI strip at full density, with a 14-day sparkline drawn to scale (min 3 → y 26, max 14 → y 2, x step 120/13), a stacked DIAN-readiness bar strip (412/61/9 of 482 = 85.48 % / 12.66 % / 1.87 %) and an allowance meter (1,9 M of 2,5 M = 76 %, 80 % tick).
```html
<section class="flex w-[1040px] flex-col rounded-lg border border-line bg-surface" aria-label="Indicadores">
  <div class="flex items-center gap-1.5 border-b border-dashed border-line-2 px-2.5 py-1.5 text-[11px] text-text-muted">
    <span class="tracking-[-2px] opacity-60" aria-hidden="true">⋮⋮</span><span class="text-xs font-semibold text-text">Indicadores</span><span class="grow"></span>
    <time class="font-mono" datetime="2026-10-28T10:42">Actualizado 10:42</time><button class="rounded px-1.5 text-[11px] text-primary underline">Actualizar</button>
  </div>
  <div class="grid grid-cols-4">
    <div class="flex min-w-0 flex-col border-r border-line-2 px-4 py-3.5">
      <div class="text-xs text-text-muted">Terceros activos</div>
      <div class="mt-0.5 text-[26px] font-bold tabular-nums">482</div>
      <svg viewBox="0 0 120 28" class="mt-1.5 block h-7 w-full" preserveAspectRatio="none" role="img" aria-label="Altas de los últimos 14 días: de 3 a 14 por día">
        <path d="M0,28 L0,26 L9.23,21.64 L18.46,23.82 L27.69,19.45 L36.92,15.09 L46.15,17.27 L55.38,12.91 L64.62,19.45 L73.85,10.73 L83.08,6.36 L92.31,8.55 L101.54,12.91 L110.77,4.18 L120,2 L120,28 Z" fill="var(--accent)"/>
        <path d="M0,26 L9.23,21.64 L18.46,23.82 L27.69,19.45 L36.92,15.09 L46.15,17.27 L55.38,12.91 L64.62,19.45 L73.85,10.73 L83.08,6.36 L92.31,8.55 L101.54,12.91 L110.77,4.18 L120,2" fill="none" stroke="var(--primary)" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="mt-1 text-xs text-text-muted">+14 hoy · últimos 14 días</div>
    </div>
    <div class="flex min-w-0 flex-col border-r border-line-2 px-4 py-3.5">
      <div class="text-xs text-text-muted">Listos para facturar</div>
      <div class="mt-0.5 text-[26px] font-bold tabular-nums">85 %</div>
      <svg viewBox="0 0 100 10" class="mt-2 block h-2.5 w-full" preserveAspectRatio="none" role="img" aria-label="Completos 412, faltan datos 61, con errores 9">
        <rect x="0" y="0" width="85.48" height="10" fill="var(--ok)"/>
        <rect x="85.48" y="0" width="12.66" height="10" fill="var(--warn)"/>
        <rect x="98.14" y="0" width="1.86" height="10" fill="var(--danger)"/>
      </svg>
      <div class="mt-1.5 flex gap-3 text-[11px] text-text-muted"><span><i class="mr-1 inline-block size-2 bg-ok"></i>412 completos</span><span><i class="mr-1 inline-block size-2 bg-warn"></i>61 faltan</span><span><i class="mr-1 inline-block size-2 bg-danger"></i>9 errores</span></div>
    </div>
    <div class="flex min-w-0 flex-col border-r border-line-2 px-4 py-3.5">
      <div class="text-xs text-text-muted">Importaciones (5 días)</div>
      <div class="mt-0.5 text-[26px] font-bold tabular-nums">1.262</div>
      <svg viewBox="0 0 100 40" class="mt-1 block h-10 w-full" role="img" aria-label="Filas importadas por día: 124, 352, 80, 440, 266; fallidas 4, 12, 0, 30, 6">
        <g fill="var(--primary)"><rect x="4" y="29.09" width="12" height="10.91"/><rect x="24" y="9.09" width="12" height="30.91"/><rect x="44" y="32.73" width="12" height="7.27"/><rect x="64" y="2.73" width="12" height="37.27"/><rect x="84" y="16.36" width="12" height="23.64"/></g>
        <g fill="var(--danger)"><rect x="4" y="28.73" width="12" height=".36"/><rect x="24" y="8" width="12" height="1.09"/><rect x="64" y="0" width="12" height="2.73"/><rect x="84" y="15.81" width="12" height=".55"/></g>
      </svg>
      <div class="mt-1 text-xs text-text-muted">52 filas con error</div>
    </div>
    <div class="flex min-w-0 flex-col px-4 py-3.5">
      <div class="text-xs text-text-muted">Uso de IA del mes</div>
      <div class="mt-0.5 text-[26px] font-bold tabular-nums">1,9 M <span class="text-sm font-semibold text-text-muted">76 %</span></div>
      <svg viewBox="0 0 100 22" class="block h-[22px] w-full overflow-visible" preserveAspectRatio="none" role="meter" aria-label="Uso de IA: 76 % del cupo" aria-valuemin="0" aria-valuemax="100" aria-valuenow="76">
        <rect x="0" y="8" width="100" height="6" rx="3" fill="var(--line-2)"/>
        <rect x="0" y="8" width="76" height="6" rx="3" fill="var(--primary)"/>
        <line x1="80" x2="80" y1="4" y2="18" stroke="var(--text-muted)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="text-xs text-text-muted">de 2,5 M tokens · aviso al 80 %</div>
    </div>
  </div>
</section>
```

### 2.28 `packages/ui/src/home/Widget.tsx`

**UX Friction Analysis**
- Every widget header shows its size permanently (`:74`, "4/4 · 170 px"). Users never need that number unless they are resizing, so it adds noise to each card on the home screen they see 20 times a day.
- The header is `role="button"` + `tabIndex=0` (`:60-70`), but Enter and Space do nothing. Moving the card needs Alt+arrows, which only the `title` tooltip mentions (L9).
- There is no slot for the widget's freshness ("as of"), which every snapshot widget needs (see §2.27).

**Proposed Code Diff**
```diff
--- a/packages/ui/src/home/Widget.tsx
+++ b/packages/ui/src/home/Widget.tsx
@@ export interface WidgetProps {
   title: string;
+  /** Right of the title: when the data was read, a refresh link. */
+  meta?: ReactNode;
@@
-export function Widget({ title, columns, height, dragging, over, resizing, children, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, onMoveKey, onResizeStart, onResizeKey }: WidgetProps) {
+export function Widget({ title, meta, columns, height, dragging, over, resizing, children, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, onMoveKey, onResizeStart, onResizeKey }: WidgetProps) {
@@
       <div
         className="erp-wg__hd"
         draggable
         tabIndex={0}
         role="button"
+        aria-roledescription={t("draggable")}
+        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
         aria-label={t("move", { title })}
@@
         <span className="erp-wg__title">{title}</span>
         <span className="erp-grow" />
-        <span className="erp-hint">{t("size", { columns, height })}</span>
+        {meta}
+        <span className="erp-hint erp-wg__size" aria-hidden="true">{t("size", { columns, height })}</span>
       </div>
```
`Dashboard` passes `meta` from a new optional `DashboardWidget.meta`. `HomeScreen` sets it to `<time className="erp-wg__asof">{t("common.live.updated", { time })}</time>` plus a "Actualizar" link (`router.refresh()`), with `asOf` taken from `HomeData`. That is a loader field, not a contract change.

**Pure Tailwind & SVG Prototype Block**
```html
<div class="grid w-[1040px] grid-cols-4 gap-3">
  <section class="col-span-2 flex min-h-[200px] flex-col rounded-lg border border-line bg-surface" aria-label="Recomendaciones">
    <div tabindex="0" role="button" aria-roledescription="arrastrable" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" class="group flex cursor-grab items-center gap-1.5 border-b border-dashed border-line-2 px-2.5 py-1.5 text-[11px] text-text-muted select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring">
      <span class="tracking-[-2px] opacity-60" aria-hidden="true">⋮⋮</span><span class="text-xs font-semibold text-text">Recomendaciones</span><span class="grow"></span>
      <time class="font-mono">Actualizado 10:42</time>
      <span class="opacity-0 group-focus-visible:opacity-100" aria-hidden="true">2/4 · 300 px</span>
    </div>
    <div class="p-3 text-[13px] text-text-muted">…</div>
  </section>
</div>
```

### 2.29 `packages/ui/src/home/widgets.tsx` (RecentWidget, KpisWidget)

**UX Friction Analysis**
- `RecentWidget` renders a bare `<table>` inside `.erp-home-list` (`:97-128`), which has no table rules. It shows browser-default padding, no header band, no 36 px rows, and a right-aligned time column only by luck. That makes it the least dense list in the app, on the screen opened most often.
- Each record link is styled `fontSize: 14` inline (`:114`). The kind column repeats the entity name in every row.
- `KpisWidget` empty text is padded with an inline style (`:18`). That is minor.

**Proposed Code Diff** (CSS in §2.3: `.erp-home-list th/td`; the TSX only adds semantics)
```diff
--- a/packages/ui/src/home/widgets.tsx
+++ b/packages/ui/src/home/widgets.tsx
@@ RecentWidget
             <th>{t("home.recent.columns.record")}</th>
             <th>{t("home.recent.columns.kind")}</th>
             <th>{t("home.recent.columns.action")}</th>
-            <th>{t("home.recent.columns.when")}</th>
+            <th className="erp-num">{t("home.recent.columns.when")}</th>
@@
-                    <a className="erp-link" style={{ fontSize: 14 }} href={record.href} aria-label={t("home.recent.open", { title })} onClick={open(record.href)}>
+                    <a className="erp-link" style={{ fontSize: 13 }} href={record.href} aria-label={t("home.recent.open", { title })} onClick={open(record.href)}>
@@
-                <td>{t(`home.recent.${record.action}`)}</td>
-                <td className="erp-num">{formatCellValue({ type: "datetime" }, record.at, { yes: "", no: "", timeZone })}</td>
+                <td>
+                  <span className={`erp-pill erp-pill--${record.action === "insert" ? "ok" : "info"}`}>{t(`home.recent.${record.action}`)}</span>
+                </td>
+                <td className="erp-num">
+                  <time dateTime={record.at}>{formatCellValue({ type: "datetime" }, record.at, { yes: "", no: "", timeZone })}</time>
+                </td>
```

**Pure Tailwind & SVG Prototype Block**
```html
<div class="w-[1040px] overflow-hidden rounded-lg border border-line bg-surface">
  <table class="w-full border-collapse text-[13px]">
    <thead><tr><th class="h-8 border-b border-line bg-head px-3 text-left text-xs font-semibold text-text-muted">Registro</th><th class="h-8 border-b border-line bg-head px-3 text-left text-xs font-semibold text-text-muted">Tipo</th><th class="h-8 border-b border-line bg-head px-3 text-left text-xs font-semibold text-text-muted">Acción</th><th class="h-8 border-b border-line bg-head px-3 text-right text-xs font-semibold text-text-muted">Cuándo</th></tr></thead>
    <tbody>
      <tr class="hover:bg-hover"><td class="h-9 border-b border-line-2 px-3"><a href="#" class="text-primary underline">Tostadora Antioquia S.A.S.</a></td><td class="h-9 border-b border-line-2 px-3">Tercero</td><td class="h-9 border-b border-line-2 px-3"><span class="rounded-[4px] bg-ok-bg px-2 py-0.5 text-xs text-ok">Creado</span></td><td class="h-9 border-b border-line-2 px-3 text-right font-mono text-xs tabular-nums"><time datetime="2026-10-28T15:41Z">28/10/26, 10:41</time></td></tr>
      <tr class="hover:bg-hover"><td class="h-9 border-b border-line-2 px-3"><a href="#" class="text-primary underline">Café Molido 500 g</a></td><td class="h-9 border-b border-line-2 px-3">Producto</td><td class="h-9 border-b border-line-2 px-3"><span class="rounded-[4px] bg-info-bg px-2 py-0.5 text-xs text-info">Modificado</span></td><td class="h-9 border-b border-line-2 px-3 text-right font-mono text-xs tabular-nums"><time datetime="2026-10-28T15:12Z">28/10/26, 10:12</time></td></tr>
    </tbody>
  </table>
</div>
```

### 2.30 `apps/web/src/app/(app)/admin/permissions/permission-matrix.tsx`

**UX Friction Analysis**
- **The table moves under the pointer (H4).** `{status && <div style={{ padding: "8px 14px" }}>{status}</div>}` (`:44`) sits *above* the scroll area. Each toggle sets a "Guardado" or "No se pudo…" banner (`use-admin-action.tsx:34,39`), which pushes the matrix down about 40 px, then `router.refresh()` re-renders it. An admin ticking a column of 20 processes hits the row below the one they aimed at. On a security matrix that is an accuracy problem, not a cosmetic one.
- **One TOTP per cell.** Admin processes are sensitive by default (rule 15), and each run consumes the verification (`kernel/src/process/run.ts:144,237`). Setting up a new role with 30 grants means 30 codes. The fix, staging the cells and applying them with one batch process and one step-up, needs a new registered process (OWNER DECISION OD-7; rule 1 and rule 15 stay intact).
- **Density and orientation.** Three text columns (entity, process, kind, `:49-51`) come before the roles, and none is sticky. With 6 roles the process id scrolls away horizontally, and the header row is not sticky either, because `.erp-card th` sticks only inside `.erp-admin__scroll`, and the group rows have no offset. The cell is the 16 px checkbox alone (`components.css:286`), a small target. There is no row hover to keep the eye on the line.
- **No bulk actions.** There is no "all of this module for this role", which is the usual operation when creating a role.

**Proposed Code Diff**: part A fits the contract (stable status bar, sticky column, hit area). Part B is OD-7 (staging plus one batch process).
```diff
--- a/apps/web/src/app/(app)/admin/permissions/permission-matrix.tsx
+++ b/apps/web/src/app/(app)/admin/permissions/permission-matrix.tsx
@@
 export function PermissionMatrix({ data }: { data: PermissionsData }) {
   const t = useTranslations();
-  const { perform, prompt, status } = useAdminAction();
-  // What the admin just clicked, shown until the server data says the same (or the change is refused).
-  const [pending, setPending] = useState<Record<string, boolean>>({});
+  const { perform, prompt, status, busy } = useAdminAction();
+  // B (OD-7): the admin's clicks are staged here and applied together with one step-up; nothing is sent per cell.
+  const [pending, setPending] = useState<Record<string, boolean>>({});
@@
-  const toggle = async (roleId: string, processId: string, allowed: boolean) => {
-    const key = `${roleId}:${processId}`;
-    setPending((p) => ({ ...p, [key]: allowed }));
-    const ok = await perform("kernel.admin.permission.set", { roleId, processId, allowed });
-    if (!ok) setPending((current) => without(current, key));
-  };
+  const stored = (roleId: string, processId: string) => (data.grants[roleId] ?? []).includes(processId);
+  const toggle = (roleId: string, processId: string, allowed: boolean) => {
+    const key = `${roleId}:${processId}`;
+    // Back to what is stored: no longer a change.
+    setPending((p) => (allowed === stored(roleId, processId) ? without(p, key) : { ...p, [key]: allowed }));
+  };
+  const changes = Object.entries(pending).map(([key, allowed]) => {
+    const [roleId, processId] = key.split(":") as [string, string];
+    return { roleId, processId, allowed };
+  });
+  // OWNER DECISION OD-7: `kernel.admin.permission.set_many` is a new registered process (one transaction, one audit row
+  // per change, one step-up). Until it exists, `apply` can loop `kernel.admin.permission.set` and still keeps part A.
+  const apply = async () => {
+    if (await perform("kernel.admin.permission.set_many", { changes })) setPending({});
+  };
+  const setModule = (roleId: string, moduleId: string, allowed: boolean) =>
+    data.processes.filter((p) => p.module === moduleId).forEach((p) => toggle(roleId, p.id, allowed));
@@
       <div className="erp-admin__head">
         <h2>{t("common.admin.permissions.title")}</h2>
         <span className="erp-small erp-muted">{t("common.admin.permissions.hint")}</span>
-        <span className="erp-grow" />
-        <span className="erp-small erp-muted">{t("common.admin.step_up_note")}</span>
       </div>
-      {status && <div style={{ padding: "8px 14px" }}>{status}</div>}
       <div className="erp-admin__scroll">
         <table className="erp-matrix">
           <thead>
             <tr>
-              <th>{t("common.admin.permissions.col_entity")}</th>
-              <th className="erp-matrix__left">{t("common.admin.permissions.col_process")}</th>
-              <th>{t("common.admin.permissions.col_kind")}</th>
+              <th className="erp-matrix__left">{t("common.admin.permissions.col_process")}</th>
               {data.roles.map((role) => (
-                <th key={role.id} title={role.isSystemAdmin ? t("common.admin.permissions.admin_locked") : role.description}>
+                <th key={role.id} className="erp-matrix__role" scope="col" title={role.isSystemAdmin ? t("common.admin.permissions.admin_locked") : role.description}>
                   {role.name}
                 </th>
               ))}
@@
                 <tr className="erp-matrix__group">
-                  <td colSpan={3 + data.roles.length}>{t(`nav.modules.${moduleId}`)}</td>
+                  <td className="erp-matrix__left">{t(`nav.modules.${moduleId}`)}</td>
+                  {data.roles.map((role) => (
+                    <td key={role.id}>
+                      {!role.isSystemAdmin && (
+                        <button type="button" className="erp-link" onClick={() => setModule(role.id, moduleId, true)} aria-label={t("common.admin.permissions.grant_module", { role: role.name, module: t(`nav.modules.${moduleId}`) })}>
+                          {t("common.admin.permissions.all")}
+                        </button>
+                      )}
+                    </td>
+                  ))}
                 </tr>
@@
                     <tr key={process.id}>
-                      <td>
-                        <span>{t.has(process.entityLabel) ? t(process.entityLabel) : process.entity}</span>{" "}
-                        <span className="erp-hint erp-mono erp-small erp-muted">{process.entity}</span>
-                      </td>
-                      <td className="erp-matrix__left erp-mono erp-small">
-                        {process.id}
+                      <th scope="row" className="erp-matrix__left" style={{ fontWeight: 400 }}>
+                        <span className="erp-mono erp-small">{process.id}</span>{" "}
+                        <span className="erp-pill erp-pill--gray">{t(`common.admin.kind.${process.kind}`)}</span>
                         {process.stepUp && (
@@
                         )}
-                      </td>
-                      <td className="erp-small">{t(`common.admin.kind.${process.kind}`)}</td>
+                        <div className="erp-small erp-muted">{t.has(process.entityLabel) ? t(process.entityLabel) : process.entity}</div>
+                      </th>
                       {data.roles.map((role) => (
-                        <td key={role.id}>
-                          <input
-                            type="checkbox"
-                            aria-label={`${role.name} ${process.id}`}
-                            checked={role.isSystemAdmin || granted(role.id, process.id)}
-                            disabled={role.isSystemAdmin}
-                            onChange={(event) => void toggle(role.id, process.id, event.target.checked)}
-                          />
+                        <td key={role.id} className={`${role.id}:${process.id}` in pending ? "is-dirty" : undefined}>
+                          {/* The whole 32 px cell is the target. */}
+                          <label className="erp-matrix__hit">
+                            <input
+                              type="checkbox"
+                              aria-label={`${role.name} ${process.id}`}
+                              checked={role.isSystemAdmin || granted(role.id, process.id)}
+                              disabled={role.isSystemAdmin || busy}
+                              onChange={(event) => toggle(role.id, process.id, event.target.checked)}
+                            />
+                          </label>
                         </td>
                       ))}
@@
         </table>
       </div>
+      {/* A: one fixed bar under the matrix holds the outcome and the pending changes; the table above never moves. */}
+      <div className="erp-admin__bar" role="status">
+        {changes.length > 0 ? (
+          <>
+            <span className="erp-pill erp-pill--warn">{t("common.admin.pending_changes", { count: changes.length })}</span>
+            <span className="erp-small erp-muted erp-grow">{t("common.admin.step_up_note")}</span>
+            <button type="button" className="erp-btn" onClick={() => setPending({})} disabled={busy}>
+              {t("common.admin.discard_changes")}
+            </button>
+            <button type="button" className="erp-btn erp-btn--primary" onClick={() => void apply()} disabled={busy}>
+              {t("common.admin.apply_changes")}
+            </button>
+          </>
+        ) : (
+          <span className="erp-grow">{status}</span>
+        )}
+      </div>
       <StepUpDock prompt={prompt} />
```
The colour-coded dirty cell also carries a shape cue (an inset ring, §2.3), and the pending count is written out. The permission-matrix tests (unit and `apps/web/e2e`) must change: a click no longer runs a process by itself.

**Pure Tailwind & SVG Prototype Block**: sticky process column and role header, 32 px rows, row hover, staged cells with an inset ring, and the fixed apply bar.
```html
<section class="flex w-[900px] flex-col rounded-lg border border-line bg-surface text-[13px]">
  <div class="flex items-center gap-2.5 border-b border-line-2 px-3.5 py-2.5"><h2 class="m-0 text-[15px] font-bold">Permisos por rol</h2><span class="text-xs text-text-muted">Las columnas son los roles; cada proceso muestra la entidad sobre la que actúa.</span></div>
  <div class="max-h-[300px] overflow-auto">
    <table class="w-full border-collapse">
      <thead><tr>
        <th class="sticky top-0 left-0 z-30 h-9 min-w-[280px] border-b border-line bg-head px-2 text-left text-xs font-semibold text-text-muted shadow-[1px_0_0_var(--line)]">Proceso</th>
        <th scope="col" class="sticky top-0 z-20 h-9 max-w-[120px] border-b border-line bg-head px-1.5 text-xs font-semibold text-text-muted">Administrador</th>
        <th scope="col" class="sticky top-0 z-20 h-9 border-b border-line bg-head px-1.5 text-xs font-semibold text-text-muted">Ventas</th>
        <th scope="col" class="sticky top-0 z-20 h-9 border-b border-line bg-head px-1.5 text-xs font-semibold text-text-muted">Compras</th>
        <th scope="col" class="sticky top-0 z-20 h-9 border-b border-line bg-head px-1.5 text-xs font-semibold text-text-muted">Contabilidad</th>
      </tr></thead>
      <tbody>
        <tr><td class="sticky left-0 z-10 h-8 bg-head px-2 text-xs font-bold tracking-[.04em] text-text-muted uppercase shadow-[1px_0_0_var(--line)]">Base</td><td class="h-8 bg-head"></td><td class="h-8 bg-head text-center"><button class="text-xs text-primary underline">todos</button></td><td class="h-8 bg-head text-center"><button class="text-xs text-primary underline">todos</button></td><td class="h-8 bg-head text-center"><button class="text-xs text-primary underline">todos</button></td></tr>
        <tr class="group">
          <th scope="row" class="sticky left-0 z-10 h-8 bg-surface px-2 text-left font-normal shadow-[1px_0_0_var(--line)] group-hover:bg-hover"><span class="font-mono text-xs">core.party.create</span> <span class="rounded-[4px] bg-line-2 px-1.5 text-[11px] text-text-muted">crear</span><div class="text-xs text-text-muted">Tercero</div></th>
          <td class="h-8 text-center group-hover:bg-hover"><label class="grid h-8 place-items-center"><input type="checkbox" checked disabled class="size-4 accent-primary"></label></td>
          <td class="h-8 text-center group-hover:bg-hover"><label class="grid h-8 cursor-pointer place-items-center"><input type="checkbox" checked class="size-4 accent-primary"></label></td>
          <td class="h-8 text-center shadow-[inset_0_0_0_2px_var(--warn)] group-hover:bg-hover"><label class="grid h-8 cursor-pointer place-items-center"><input type="checkbox" checked class="size-4 accent-primary" aria-label="Compras core.party.create (sin aplicar)"></label></td>
          <td class="h-8 text-center group-hover:bg-hover"><label class="grid h-8 cursor-pointer place-items-center"><input type="checkbox" class="size-4 accent-primary"></label></td>
        </tr>
        <tr class="group">
          <th scope="row" class="sticky left-0 z-10 h-8 bg-surface px-2 text-left font-normal shadow-[1px_0_0_var(--line)] group-hover:bg-hover"><span class="font-mono text-xs">core.party.update</span> <span class="rounded-[4px] bg-line-2 px-1.5 text-[11px] text-text-muted">actualizar</span> <span class="rounded-[4px] bg-warn-bg px-1.5 text-[11px] text-warn">2FA</span><div class="text-xs text-text-muted">Tercero</div></th>
          <td class="h-8 text-center group-hover:bg-hover"><label class="grid h-8 place-items-center"><input type="checkbox" checked disabled class="size-4 accent-primary"></label></td>
          <td class="h-8 text-center shadow-[inset_0_0_0_2px_var(--warn)] group-hover:bg-hover"><label class="grid h-8 cursor-pointer place-items-center"><input type="checkbox" class="size-4 accent-primary"></label></td>
          <td class="h-8 text-center group-hover:bg-hover"><label class="grid h-8 cursor-pointer place-items-center"><input type="checkbox" class="size-4 accent-primary"></label></td>
          <td class="h-8 text-center group-hover:bg-hover"><label class="grid h-8 cursor-pointer place-items-center"><input type="checkbox" class="size-4 accent-primary"></label></td>
        </tr>
      </tbody>
    </table>
  </div>
  <div role="status" class="sticky bottom-0 flex min-h-11 items-center gap-2 rounded-b-lg border-t border-line-2 bg-head px-3.5 py-1.5">
    <span class="rounded-[4px] bg-warn-bg px-2 py-0.5 text-xs text-warn">2 cambios sin aplicar</span>
    <span class="grow text-xs text-text-muted">Se aplican juntos con un código de verificación.</span>
    <button class="rounded-md border border-line bg-surface px-3 py-[7px]">Descartar</button>
    <button class="rounded-md bg-primary px-3 py-[7px] font-semibold text-white">Aplicar cambios</button>
  </div>
</section>
```

### 2.31 `apps/web/src/app/(app)/admin/fields/fields-screen.tsx`

**UX Friction Analysis**
- The same shifting banner (`:54`), the same one-TOTP-per-cell, and the same non-sticky field column (`:69-72`) as the permission matrix.
- The `masked` and `hidden` selects are tinted warn and danger (`components.css:289-290`) and keep their text, so they are not colour-only. With 6 roles, though, each `<select>` is about 90 px, and the field label column wraps. Reading "which roles see the NIT" means scanning horizontally across 6 coloured selects with no row hover.
- The entity `<select>` sits in the header with an `sr-only` label (`:40-51`). That is fine.

**Proposed Code Diff** (part A only; part B mirrors §2.30 with `kernel.admin.field_permission.set_many`)
```diff
--- a/apps/web/src/app/(app)/admin/fields/fields-screen.tsx
+++ b/apps/web/src/app/(app)/admin/fields/fields-screen.tsx
@@
-      {status && <div style={{ padding: "8px 14px" }}>{status}</div>}
       {entity && (
         <div className="erp-admin__scroll">
           <table className="erp-matrix">
             <thead>
               <tr>
-                <th>{t("common.admin.fields.col_field")}</th>
+                <th className="erp-matrix__left">{t("common.admin.fields.col_field")}</th>
                 {roles.map((role) => (
-                  <th key={role.id}>{role.name}</th>
+                  <th key={role.id} className="erp-matrix__role" scope="col">{role.name}</th>
                 ))}
@@
                 <tr key={field.name}>
-                  <td>
+                  <th scope="row" className="erp-matrix__left" style={{ fontWeight: 400 }}>
                     {label(field.label, field.name)} <span className="erp-hint erp-mono erp-small erp-muted">{field.name}</span>{" "}
                     {field.confidential && <span className="erp-pill erp-pill--warn">{t("common.admin.fields.confidential")}</span>}
-                  </td>
+                  </th>
@@
-                      <td key={role.id}>
+                      <td key={role.id} className={`${entityId}.${field.name}:${role.id}` in pending ? "is-dirty" : undefined}>
                         <select
                           aria-label={`${role.name} ${label(field.label, field.name)}`}
                           className={mode === "masked" ? "is-masked" : mode === "hidden" ? "is-hidden" : undefined}
@@
-      <div className="erp-small erp-muted" style={{ padding: "8px 14px" }}>
-        {t("common.admin.fields.admin_note")}
-      </div>
+      <div className="erp-admin__bar" role="status">
+        <span className="erp-small erp-muted erp-grow">{status ?? t("common.admin.fields.admin_note")}</span>
+      </div>
```

**Pure Tailwind & SVG Prototype Block**
```html
<table class="w-[760px] border-collapse rounded-lg bg-surface text-[13px]">
  <thead><tr><th class="sticky left-0 h-9 border-b border-line bg-head px-2 text-left text-xs text-text-muted">Campo</th><th class="h-9 border-b border-line bg-head text-xs text-text-muted">Ventas</th><th class="h-9 border-b border-line bg-head text-xs text-text-muted">Compras</th><th class="h-9 border-b border-line bg-head text-xs text-text-muted">Bodega</th></tr></thead>
  <tbody>
    <tr class="group"><th scope="row" class="sticky left-0 h-8 bg-surface px-2 text-left font-normal group-hover:bg-hover">Cupo de crédito <span class="font-mono text-[11px] text-text-muted">credit_limit</span> <span class="rounded-[4px] bg-warn-bg px-1.5 text-[11px] text-warn">confidencial</span></th>
      <td class="h-8 text-center group-hover:bg-hover"><select class="h-[26px] rounded-[4px] border border-line-input bg-surface px-1.5 text-xs"><option>Visible</option></select></td>
      <td class="h-8 text-center shadow-[inset_0_0_0_2px_var(--warn)] group-hover:bg-hover"><select class="h-[26px] rounded-[4px] border border-line-input bg-warn-bg px-1.5 text-xs text-warn"><option>Enmascarado</option></select></td>
      <td class="h-8 text-center group-hover:bg-hover"><select class="h-[26px] rounded-[4px] border border-line-input bg-danger-bg px-1.5 text-xs text-danger"><option>Oculto</option></select></td></tr>
  </tbody>
</table>
```

### 2.32 `apps/web/src/app/(app)/admin/ai-usage/ai-usage-screen.tsx`

**UX Friction Analysis**
- The allowance bar (`:35-46`) is 8 px with no 80 % warning tick, and the percentage is never written. "1.912.400 de 2.500.000" makes the admin do the division. Over the cap it turns red, a colour-only state, with no text saying "límite alcanzado: solo consultas" (rule 27).
- The USD format keeps up to 4 decimals (`:16`), so a column of costs ragged-aligns: "0,0123" next to "12,5". Tabular figures without fixed decimals do not align.
- The per-user and per-model tables are plain `.erp-card table` with no totals row.

**Proposed Code Diff**
```diff
--- a/apps/web/src/app/(app)/admin/ai-usage/ai-usage-screen.tsx
+++ b/apps/web/src/app/(app)/admin/ai-usage/ai-usage-screen.tsx
@@
+import { ShareMeter } from "@erp/ui";
@@
-  const usd = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
+  // Fixed decimals so the cost column aligns on the decimal separator.
+  const usd = new Intl.NumberFormat(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
+  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
@@
-          {data.limit !== null && (
-            <div
-              className={`erp-bar${over ? " is-over" : ""}`}
-              role="meter"
-              aria-label={t("common.admin.ai_usage.bar")}
-              aria-valuemin={0}
-              aria-valuemax={data.limit}
-              aria-valuenow={Math.min(data.used, data.limit)}
-            >
-              <i style={{ width: `${share}%` }} />
-            </div>
-          )}
+          {data.limit !== null && (
+            <>
+              <ShareMeter value={data.used / data.limit} label={t("common.admin.ai_usage.bar")} />
+              <span className={over ? "erp-pill erp-pill--danger" : share >= 80 ? "erp-pill erp-pill--warn" : "erp-small erp-muted"}>
+                {pct.format(data.used / data.limit)}
+                {over ? ` · ${t("common.admin.ai_usage.cap_reached")}` : ""}
+              </span>
+            </>
+          )}
```
(`ShareMeter` from §2.27 is exported through `packages/ui/src/home/index.ts`.)

**Pure Tailwind & SVG Prototype Block**: allowance meter with 80 % and 100 % marks and an over-cap state that writes its meaning out.
```html
<div class="grid w-[720px] grid-cols-2 gap-3">
  <div class="flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-4 py-3.5">
    <span class="text-xs text-text-muted">Tokens del mes</span><span class="text-2xl font-bold tabular-nums">1.912.400</span>
    <svg viewBox="0 0 100 22" class="block h-[22px] w-full overflow-visible" preserveAspectRatio="none" role="meter" aria-label="Uso del cupo: 76 %" aria-valuemin="0" aria-valuemax="100" aria-valuenow="76"><rect x="0" y="8" width="100" height="6" rx="3" fill="var(--line-2)"/><rect x="0" y="8" width="76.5" height="6" rx="3" fill="var(--primary)"/><line x1="80" x2="80" y1="4" y2="18" stroke="var(--text-muted)" vector-effect="non-scaling-stroke"/></svg>
    <span class="text-xs text-text-muted"><b class="text-text tabular-nums">76 %</b> de 2.500.000 · aviso al 80 %</span>
  </div>
  <div class="flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-4 py-3.5">
    <span class="text-xs text-text-muted">Tokens del mes</span><span class="text-2xl font-bold tabular-nums">2.500.000</span>
    <svg viewBox="0 0 100 22" class="block h-[22px] w-full overflow-visible" preserveAspectRatio="none" role="meter" aria-label="Uso del cupo: 100 %, límite alcanzado" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><rect x="0" y="8" width="100" height="6" rx="3" fill="var(--danger)"/><line x1="80" x2="80" y1="4" y2="18" stroke="var(--text-muted)" vector-effect="non-scaling-stroke"/></svg>
    <span class="self-start rounded-[4px] bg-danger-bg px-2 py-0.5 text-xs text-danger">100 % · límite alcanzado: el asistente solo responde consultas</span>
  </div>
</div>
```

### 2.33 `apps/web/src/app/(app)/import/import-page.tsx`

**UX Friction Analysis**
- **Polling the user cannot see (M1).** While an import is queued or running, the history re-reads every 3 s (`:29-33`). Nothing on screen says it is following, how fresh the table is, or that it stopped.
- **Polling dies quietly.** `refresh` (`:23-26`) does not catch errors. One failed fetch (VPN drop, deploy) rejects, `items` stays the same, the effect never re-arms, and the row says "en curso" forever. The user waits for an import that finished long ago.
- **It never pauses.** It keeps polling in a hidden browser tab all shift.
- **No progress.** A running import shows a pill but not `rowsOk + rowsFailed` of `rowsTotal`, although `ImportHistoryItem` carries all three (`import-model.ts:30-32`).
- **Mixed time zone.** Dates use the browser's zone (`:21`), while the rest of the app uses the company's (`CellFormatProvider`).

**Proposed Code Diff**: a shared `LiveStatus` (new, `packages/ui/src/live/LiveStatus.tsx`) plus a polling loop that pauses, resumes and survives errors.
```tsx
// packages/ui/src/live/LiveStatus.tsx (new) — "En vivo / En pausa / Sin conexión" with the time of the last read.
"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCellTimeZone } from "../grid/cell-format";

export type LiveState = "idle" | "live" | "paused" | "error";

export function LiveStatus({ state, at, onResume }: { state: LiveState; at: Date | null; onResume?: () => void }) {
  const t = useTranslations("common.live");
  const locale = useLocale();
  const timeZone = useCellTimeZone();
  const time = at ? new Intl.DateTimeFormat(locale, { timeStyle: "medium", ...(timeZone ? { timeZone } : {}) }).format(at) : null;
  if (state === "idle") return time ? <span className="erp-small erp-muted">{t("updated", { time })}</span> : null;
  return (
    <span role="status" className={`erp-live${state === "paused" ? " is-paused" : state === "error" ? " is-error" : ""}`}>
      <i aria-hidden="true" />
      {t(state === "live" ? "on" : state === "paused" ? "paused" : "error")}
      {time && <span className="erp-mono">· {time}</span>}
      {state !== "live" && onResume && (
        <button type="button" className="erp-link" onClick={onResume}>
          {t("resume")}
        </button>
      )}
    </span>
  );
}
```
```diff
--- a/apps/web/src/app/(app)/import/import-page.tsx
+++ b/apps/web/src/app/(app)/import/import-page.tsx
@@
-import { ImportDialog, ImportIcon, importPending, type ImportHistoryItem } from "@erp/ui";
+import { ImportDialog, ImportIcon, importPending, LiveStatus, formatCellValue, useCellTimeZone, type ImportHistoryItem, type LiveState } from "@erp/ui";
@@
   const [items, setItems] = useState<ImportHistoryItem[]>(data.history);
   const [failure, setFailure] = useState<string | null>(null);
-  const when = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
+  const timeZone = useCellTimeZone();
+  const when = (iso: string) => formatCellValue({ type: "datetime" }, iso, { yes: "", no: "", timeZone });
+  const [poll, setPoll] = useState<{ state: LiveState; at: Date | null }>({ state: importPending(data.history) ? "live" : "idle", at: null });
+  const [visible, setVisible] = useState(true);
 
   const refresh = useCallback(async () => {
-    const response = await fetch("/api/import");
-    if (response.ok) setItems((await response.json()) as ImportHistoryItem[]);
+    try {
+      const response = await fetch("/api/import");
+      if (!response.ok) throw new Error(String(response.status));
+      const next = (await response.json()) as ImportHistoryItem[];
+      setItems(next);
+      setPoll({ state: importPending(next) ? "live" : "idle", at: new Date() });
+    } catch {
+      // Said on screen, with "Reanudar": never a silent stop.
+      setPoll((p) => ({ ...p, state: "error" }));
+    }
   }, []);
 
-  // Follow the imports in progress until they end.
+  useEffect(() => {
+    const onVisibility = () => setVisible(document.visibilityState === "visible");
+    document.addEventListener("visibilitychange", onVisibility);
+    return () => document.removeEventListener("visibilitychange", onVisibility);
+  }, []);
+  // Follow the imports in progress until they end; pause while the browser tab is hidden and read at once when it shows.
   useEffect(() => {
-    if (!importPending(items)) return;
-    const timer = setTimeout(() => void refresh(), REFRESH_MS);
+    if (!importPending(items) || poll.state === "error") return;
+    if (!visible) {
+      setPoll((p) => (p.state === "paused" ? p : { ...p, state: "paused" }));
+      return;
+    }
+    const timer = setTimeout(() => void refresh(), poll.state === "paused" ? 0 : REFRESH_MS);
     return () => clearTimeout(timer);
-  }, [items, refresh]);
+  }, [items, refresh, visible, poll.state]);
@@
         <div className="erp-row">
           <h2>{t("grid.import.history")}</h2>
           <span className="erp-grow" />
+          <LiveStatus state={poll.state} at={poll.at} onResume={() => void refresh()} />
           <button type="button" className="erp-btn erp-btn--sm" onClick={() => void refresh()}>
@@
-        <table>
+        <table style={{ tableLayout: "fixed" }}>
+          {/* Fixed column widths: counts that tick up never make the columns jump. */}
+          <colgroup>
+            <col style={{ width: 132 }} /><col style={{ width: 120 }} /><col /><col style={{ width: 150 }} /><col style={{ width: 170 }} /><col style={{ width: 80 }} /><col style={{ width: 80 }} /><col style={{ width: 110 }} />
+          </colgroup>
@@
-                  <td className="erp-mono erp-small">{when.format(new Date(item.createdAt))}</td>
+                  <td className="erp-mono erp-small"><time dateTime={item.createdAt}>{when(item.createdAt)}</time></td>
@@
                   <td>
                     <span className={`erp-pill erp-pill--${STATUS_TONE[item.status ?? ""] ?? "gray"}`}>{item.status ? t(`grid.import.status.${item.status}`) : ""}</span>
+                    {item.status === "running" && item.rowsTotal ? (
+                      <div
+                        className="erp-bar"
+                        style={{ height: 4, marginTop: 4 }}
+                        role="progressbar"
+                        aria-label={t("grid.import.progress", { done: (item.rowsOk ?? 0) + (item.rowsFailed ?? 0), total: item.rowsTotal })}
+                        aria-valuemin={0}
+                        aria-valuemax={item.rowsTotal}
+                        aria-valuenow={(item.rowsOk ?? 0) + (item.rowsFailed ?? 0)}
+                      >
+                        <i style={{ width: `${Math.round((((item.rowsOk ?? 0) + (item.rowsFailed ?? 0)) / item.rowsTotal) * 100)}%`, transition: "width .3s" }} />
+                      </div>
+                    ) : null}
                     {item.error && <div className="erp-small erp-muted">{failureText(item.error)}</div>}
```
(`locale` stays in use for nothing else and can go. The same `LiveStatus` fits the support inbox and, in phase 2, the outbox-driven screens.)

**Pure Tailwind & SVG Prototype Block**: import history with live status, fixed column widths and a running row's progress.
```html
<section class="flex w-[1040px] flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3.5 text-[13px]">
  <div class="flex items-center gap-2"><h2 class="m-0 text-[15px] font-bold">Historial de importaciones</h2><span class="grow"></span>
    <span role="status" class="inline-flex h-5 items-center gap-1.5 rounded-full border border-line-2 bg-head px-2 text-xs text-text-muted"><i class="size-2 rounded-full bg-ok"></i>En vivo <span class="font-mono">· 10:42:07</span></span>
    <button class="rounded-md border border-line px-2.5 py-[5px] text-xs">Actualizar</button>
  </div>
  <table class="w-full table-fixed border-collapse">
    <colgroup><col class="w-[132px]"><col class="w-[120px]"><col><col class="w-[150px]"><col class="w-[170px]"><col class="w-20"><col class="w-20"><col class="w-[110px]"></colgroup>
    <thead><tr class="text-xs font-semibold text-text-muted"><th class="sticky top-0 border-b border-line bg-head px-2.5 py-1.5 text-left">Fecha</th><th class="border-b border-line bg-head px-2.5 text-left">Entidad</th><th class="border-b border-line bg-head px-2.5 text-left">Archivo</th><th class="border-b border-line bg-head px-2.5 text-left">Usuario</th><th class="border-b border-line bg-head px-2.5 text-left">Estado</th><th class="border-b border-line bg-head px-2.5 text-right">OK</th><th class="border-b border-line bg-head px-2.5 text-right">Con error</th><th class="border-b border-line bg-head px-2.5 text-left">Errores</th></tr></thead>
    <tbody>
      <tr><td class="h-11 border-b border-line-2 px-2.5 font-mono text-xs"><time>28/10/26, 10:40</time></td><td class="border-b border-line-2 px-2.5">Terceros</td><td class="truncate border-b border-line-2 px-2.5">clientes-antioquia.xlsx</td><td class="truncate border-b border-line-2 px-2.5">Laura Gómez</td>
        <td class="border-b border-line-2 px-2.5"><span class="rounded-[4px] bg-info-bg px-2 py-0.5 text-xs text-info">en curso</span>
          <div class="mt-1 h-1 overflow-hidden rounded bg-line-2" role="progressbar" aria-valuemin="0" aria-valuemax="2400" aria-valuenow="1380" aria-label="1.380 de 2.400 filas"><i class="block h-full w-[57.5%] bg-primary"></i></div></td>
        <td class="border-b border-line-2 px-2.5 text-right tabular-nums">1.352</td><td class="border-b border-line-2 px-2.5 text-right tabular-nums">28</td><td class="border-b border-line-2 px-2.5"></td></tr>
      <tr><td class="h-9 border-b border-line-2 px-2.5 font-mono text-xs"><time>28/10/26, 09:12</time></td><td class="border-b border-line-2 px-2.5">Productos</td><td class="truncate border-b border-line-2 px-2.5">catalogo-octubre.csv</td><td class="truncate border-b border-line-2 px-2.5">Andrés Ruiz</td><td class="border-b border-line-2 px-2.5"><span class="rounded-[4px] bg-ok-bg px-2 py-0.5 text-xs text-ok">terminada</span></td><td class="border-b border-line-2 px-2.5 text-right tabular-nums">340</td><td class="border-b border-line-2 px-2.5 text-right tabular-nums">12</td><td class="border-b border-line-2 px-2.5"><button class="text-xs text-primary underline">errores.csv</button></td></tr>
    </tbody>
  </table>
</section>
```

### 2.34 `packages/ui/src/import/ImportDialog.tsx`

**UX Friction Analysis**
- The chooser is the hidden-input-in-label pattern again (`:190-201`), unreachable by keyboard (H1).
- **Preview of a 2,000-row file.** The preview interleaves valid and invalid rows (`:233-251`). Finding the 40 bad rows means scrolling a 260 px box (`components.css:205`). There is no "solo filas con error" filter, and the error text wraps rows to 2–4 lines, so row heights jump as the user scrolls (M16).
- **Checking state shifts the layout.** While the file is checked (`:206`), a one-line "Revisando…" appears. The preview section then mounts at full height, pushing the footer buttons down by about 300 px inside an `88vh` dialog.

**Proposed Code Diff**
```diff
--- a/packages/ui/src/import/ImportDialog.tsx
+++ b/packages/ui/src/import/ImportDialog.tsx
@@
   const [over, setOver] = useState(false);
+  const [onlyErrors, setOnlyErrors] = useState(false);
+  const fileInput = useRef<HTMLInputElement>(null);
@@
-              <label className="erp-link">
-                {t("grid.import.choose")}
-                <input
-                  type="file"
-                  accept=".xlsx,.csv,text/csv"
-                  hidden
-                  onChange={(event) => {
-                    void choose(event.target.files?.[0]);
-                    event.target.value = "";
-                  }}
-                />
-              </label>
+              <button type="button" className="erp-link" style={{ fontSize: 13 }} onClick={() => fileInput.current?.click()}>
+                {t("grid.import.choose")}
+              </button>
+              <input
+                ref={fileInput}
+                type="file"
+                accept=".xlsx,.csv,text/csv"
+                hidden
+                tabIndex={-1}
+                onChange={(event) => {
+                  void choose(event.target.files?.[0]);
+                  event.target.value = "";
+                }}
+              />
@@
-          {phase.kind === "checking" && <div className="erp-small erp-muted">{t("grid.import.checking")}</div>}
+          <div className="erp-small erp-muted" role="status" style={{ minHeight: 18 }}>
+            {phase.kind === "checking" ? t("grid.import.checking") : ""}
+          </div>
@@
             {preview.unknownHeaders.length > 0 && <div className="erp-small erp-muted">{t("grid.import.unknown_headers", { headers: preview.unknownHeaders.join(", ") })}</div>}
+            <label className="erp-check">
+              <input type="checkbox" checked={onlyErrors} disabled={counts.invalid === 0} onChange={(e) => setOnlyErrors(e.target.checked)} />
+              {t("grid.import.only_errors", { count: counts.invalid })}
+            </label>
@@
-                  {preview.rows.map((row) => (
+                  {preview.rows.filter((row) => !onlyErrors || !row.ok).map((row) => (
                     <tr key={row.rowNo}>
                       <td className="erp-num">{row.rowNo}</td>
                       <td className="erp-import__result">
@@
-                            <span className="erp-pill erp-pill--danger">{t("grid.import.row_bad")}</span> <span className="erp-small">{row.errors.join(" · ")}</span>
+                            {/* One line per row; the whole list in the tooltip and for screen readers. */}
+                            <span className="erp-pill erp-pill--danger">{t("grid.import.row_bad")}</span>{" "}
+                            <span className="erp-small" title={row.errors.join(" · ")} style={{ display: "inline-block", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}>
+                              {row.errors.join(" · ")}
+                            </span>
```
CSS: `.erp-import__table { min-height: 160px; }` so the section keeps its height between "Revisando…" and the preview, and `.erp-import__table td { height: 32px; }`.

**Pure Tailwind & SVG Prototype Block**
```html
<div class="flex w-[860px] flex-col overflow-hidden rounded-lg border border-line bg-surface text-[13px]">
  <div class="flex items-center gap-2 border-b border-line-2 px-[18px] py-3"><b class="grow text-[15px]">Importar terceros</b><button class="rounded-md px-2 text-text-muted" aria-label="Cerrar">✕</button></div>
  <div class="flex flex-col gap-3 p-[18px]">
    <div class="flex flex-col items-center gap-1.5 rounded-lg border-2 border-dashed border-line bg-head p-[18px] text-center text-text-muted"><div><b class="text-text">Arrastra el archivo aquí</b> o <button class="font-semibold text-primary underline">elígelo</button></div><div class="text-xs">Excel o CSV · hasta 25 MB</div></div>
    <div class="min-h-[18px] text-xs text-text-muted" role="status">Archivo: clientes-antioquia.xlsx</div>
    <h3 class="m-0 flex items-center gap-1.5 text-xs font-bold tracking-[.04em] text-text-muted uppercase">Vista previa · 2.400 filas <span class="rounded-[4px] bg-ok-bg px-2 py-0.5 normal-case text-ok">2.360 válidas</span><span class="rounded-[4px] bg-danger-bg px-2 py-0.5 normal-case text-danger">40 con error</span></h3>
    <label class="flex items-center gap-1.5"><input type="checkbox" checked class="accent-primary">Solo filas con error (40)</label>
    <div class="max-h-[260px] min-h-[160px] overflow-auto rounded-md border border-line-2">
      <table class="w-full border-collapse">
        <thead><tr class="text-xs font-semibold text-text-muted"><th class="sticky top-0 border-b border-line bg-head px-2.5 py-1.5 text-right">Fila</th><th class="sticky top-0 border-b border-line bg-head px-2.5 text-left">Resultado</th><th class="sticky top-0 border-b border-line bg-head px-2.5 text-left">razon_social</th><th class="sticky top-0 border-b border-line bg-head px-2.5 text-left">nit</th></tr></thead>
        <tbody>
          <tr><td class="h-8 border-b border-line-2 px-2.5 text-right tabular-nums">14</td><td class="h-8 border-b border-line-2 px-2.5 whitespace-nowrap"><span class="rounded-[4px] bg-danger-bg px-2 py-0.5 text-xs text-danger">Con error</span> <span class="inline-block max-w-[260px] truncate align-bottom text-xs" title="nit: solo dígitos · municipio: código DANE desconocido">nit: solo dígitos · municipio: código DANE desconocido</span></td><td class="h-8 border-b border-line-2 px-2.5 text-xs">Granos del Sur</td><td class="h-8 border-b border-line-2 px-2.5 font-mono text-xs">71.234.567A</td></tr>
          <tr><td class="h-8 border-b border-line-2 px-2.5 text-right tabular-nums">87</td><td class="h-8 border-b border-line-2 px-2.5 whitespace-nowrap"><span class="rounded-[4px] bg-danger-bg px-2 py-0.5 text-xs text-danger">Con error</span> <span class="inline-block max-w-[260px] truncate align-bottom text-xs">correo de facturación inválido</span></td><td class="h-8 border-b border-line-2 px-2.5 text-xs">Café La Loma</td><td class="h-8 border-b border-line-2 px-2.5 font-mono text-xs">900555666</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  <div class="flex items-center justify-end gap-2 border-t border-line-2 bg-head px-[18px] py-3"><button class="rounded-md border border-line bg-surface px-3 py-[7px]">Cancelar</button><button class="rounded-md bg-primary px-3 py-[7px] font-semibold text-white">Importar 2.360 filas válidas</button></div>
</div>
```

New exports the diffs above rely on (one line each): `packages/ui/src/home/index.ts` → `export { ShareMeter, Sparkline } from "./Sparkline";`; `packages/ui/src/index.ts` → `export * from "./live";` (with `live/index.ts` exporting `LiveStatus` and `LiveState`); `packages/ui/src/grid/index.ts` → `export { ExportJobsProvider, useExportJobs } from "./export-jobs";`; `packages/ui/src/forms/index.ts` → `CodeCombobox`.

### Files reviewed with no change proposed

`shell/CommandPalette.tsx` (⌘K, ↑↓/Enter/Esc via cmdk, accent-insensitive matching, hint footer: good; add the new shortcuts to `nav.shell.palette.hint` once they land), `shell/ThemeToggle.tsx`, `assistant/RichText.tsx`, `assistant/ResultTable.tsx` (already tabular, right-aligned and masked; 30 px rows are right for the drawer), `grid/GridCell.tsx` (one optional `className` prop, §2.9), `grid/ColumnChooser.tsx`, `grid/ConditionChips.tsx`, `grid/ExportButtons.tsx` (icons red/green/grey per rule 20: 4.77 / 4.21 / 5.43:1 on white, all over the 3:1 needed for icons), `grid/cell-format.ts`, `grid/PartyScopeSwitches.tsx` (`role="switch"` with label: good), `money/MoneyInput.tsx` (raw digits while editing, `tabular-nums`, right-aligned: rule 23 met), `home/Dashboard.tsx`, `home/RecommendationCard.tsx`, `record/ContactsTab.tsx`, `record/ExtraDataTab.tsx` (styling now in the working tree), the admin screens not listed above (they share `erp-card` tables and the §2.30 status-bar pattern applies to every `useAdminAction` screen: roles, users, extra, required-files, sensitive, verifiers, modules, companies), `app/(app)/r/[entity]/[id]/record-status.tsx` (new in the working tree: pills with words, `common.record.dian.*`; good).

---

## 3. Owner decisions

These proposals change prototype v5, a rule's wording, a design section or a kernel contract. Each needs the owner's call and an entry in the design's §22 before code. Everything else in this report fits the contract as it stands.

| ID | Proposal | What it changes | Where | Recommendation |
|---|---|---|---|---|
| OD-1 | Tighter `<main>` padding on grid and admin routes (`gap-3 px-4 py-3` instead of 20/24/16) | Prototype v5 `main { padding: 20px 24px; gap: 16px }` | §2.4 | Optional. It gains one 36 px row per screen at 768 px of viewport height. |
| OD-2 | Dark `--primary` #2563EB for fills (white text 5.17:1) and a new `--link` token (#60A5FA dark) for text links | Dark values in the §19a token table (v5 dark `--primary` #3B82F6) | §2.1 | Accept: today's dark buttons and pager fail 4.5:1 at 13 px. |
| OD-3 | `--line-input` (#8A94A3 light, #6B7686 dark) for input boundaries, keeping `--line` for dividers | Look of every input in both themes (v5 uses `--line`) | §2.1, §2.3 | Accept: input borders at 1.39:1 fail WCAG 1.4.11. |
| OD-4 | Sticky selection and identity column in every grid | Addition to the v5 grid (`gridHtml` has sticky headers only) | §2.3, §2.9 | Accept: it is the cheapest orientation aid on wide party and product grids. |
| OD-5 | Money totals as a sticky `<tfoot>` row under their columns | v5 writes the filter totals in the footer text (§19a "selection totals in the footer") | §2.9, §2.11 | Accept, keeping the selection totals in the footer as v5 has them. |
| OD-6 | The tabs row scrolls sideways (active tab kept in view, "+" pinned) instead of clipping | v5 `.tabrow { overflow: hidden }` | §2.7 | Accept: clipped tabs are unreachable (H9). |
| OD-7 | Admin matrices stage clicks and apply them in one batch with one step-up (`kernel.admin.permission.set_many`, `kernel.admin.field_permission.set_many`) | New registered processes (design §6, rule 1). Rule 15 is unchanged: one fresh TOTP per sensitive run, now covering a batch. | §2.30, §2.31 | Accept. Today a new role with 30 grants needs 30 codes. |
| OD-8 | Abandon `components.css` for Tailwind utilities only (the audit brief's constraint) | Styling architecture of `packages/ui` | §1 | Reject: the `erp-*` layer over tokens is what keeps light and dark in one table, and it mirrors v5's class names. |
| OD-9 | Optional `series?: number[]` on the kernel `Kpi` contract (SQL-computed trend) plus `asOf` on the home data | `packages/kernel` registry contract; the KPI providers of each module | §2.27 | Accept for phase 2 KPIs; phase 1 can ship the "as of" line alone. |
| OD-10 | Assistant drawer starts closed below 1280 px viewport width | §19a "Assistant: right drawer, 400px, collapsible" (v5 opens it) | §2.4 | Owner's taste; it protects the 4-column party form on 1366 px laptops. |
| OD-11 | Enter moves to the next field in record forms (desktop ERP habit), Ctrl/⌘+S saves | Form keyboard convention (not specified in v5) | §2.17 | Optional; ship Ctrl/⌘+S first, ask users about Enter. |
| OD-12 | Move schema hints ("AdditionalAccountID", "schemeName", "TaxScheme", "ISO 3166-1") from labels into a tooltip or a "ver códigos DIAN" toggle | v5 party form content | §2.17 | Optional; it removes label wrapping in the 4-column rows. |

## 4. Quick wins (fit the contract as is, ordered by value / effort)

1. **Make every file chooser a real button.** Use `<button onClick={() => input.current?.click()}>` with the hidden input outside the label, in `attachments-panel.tsx`, `PhotosTab.tsx` and `ImportDialog.tsx`. About 10 lines each; it unblocks keyboard users on rule 22 (H1).
2. **Add a visible focus ring everywhere.** Add `--focus-ring` (#1D4ED8 / #60A5FA), set `outline-ring` without `/50`, add a base `:focus-visible` rule and swap `var(--focus)` for `var(--focus-ring)` in the outline rules (§2.1–2.3). CSS only; it fixes H3 in every screen at once, the working tree's new record-tab rules included.
3. **Stop the matrices jumping.** Move the status banner of `permission-matrix.tsx` and `fields-screen.tsx` into the fixed `.erp-admin__bar` under the table, and make the process and field column sticky (part A of §2.30–2.31). Small TSX change; it removes misclicks on security settings (H4, accuracy).
4. **Use roving tabindex in the DataGrid.** One tab stop for the rows, ↑↓ Home End PgUp PgDn, Space to select, Enter to open, `/` to filter, row checkboxes at `tabIndex=-1` (§2.9). About 50 lines; it makes every grid keyboard-operable (H2).
5. **Let the reader scroll the assistant log.** Follow the bottom only while the reader is there, add an "Ir al final" button, `aria-busy` while streaming, and a fixed 18 px status row (§2.23). About 30 lines (H6, M15).
6. **Save forms from the keyboard.** Wrap them in `<form>`, add Ctrl/⌘+S and Ctrl/⌘+Enter, focus the first `aria-invalid` field after a refusal, link hints and errors with `aria-describedby`, and stop raising one alert per field (§2.16–2.17). About 40 lines shared by the party, product and category forms (H5).
7. **Make step-up codes fast.** Autofocus the box, verify at the 6th digit, Esc cancels, and move focus to Confirmar after verification (§2.18, §2.25, §2.26). About 20 lines; it saves 3 actions per sensitive change (M7).
8. **Give the advanced filter a keyboard.** Enter applies, Alt+↓ goes to the results, roving rows and Enter picks (§2.12). About 40 lines; it restores rule 20's "row pick" for keyboard users, and for the phase 2 invoice lookups (H8).
9. **Keep grid header and footer stable.** Always render the status slot and the "Limpiar filtros" button (hidden when there is nothing to clear), keep the footer on one line, show skeleton rows and "Cargando…" instead of "0 registros" (§2.3, §2.9, §2.11). M2, M3, M4.
10. **Show and protect the import polling.** `LiveStatus` "En vivo / En pausa / Sin conexión" with the time of the last read, pause in hidden tabs, survive errors with "Reanudar", progress per running import (§2.33). M1.
11. **Keep exports alive across tab changes.** An `ExportJobsProvider` in the shell, plus a toast when a job finishes off-screen (§2.15). H7.
12. **Translate the Archivos tab.** Pass the existing `common.attachments.*` keys from `files-panel.tsx`, join tags with `Intl.ListFormat`, show upload time in the company's zone (§2.20, §2.19). M14, rule 24.
13. **Add a skip link and an assistant shortcut.** "Saltar al contenido", `#erp-main` with `tabIndex=-1`, `aria-expanded` and ⌘/ / Ctrl+/ on the Asistente toggle (§2.4–2.5). M13.
14. **Let the tabs row and record tabs move by keyboard.** ← → and Delete between tabs, a 20 px ✕ target, Home/End in the record tabs, sticky record header (§2.7 behaviour, §2.21). L3, L5. The scroll part is OD-6.
15. **Settle home noise.** Show the widget size hint only while resizing or focused, style the recent-records table, add a "Actualizado hh:mm" line from the loader (§2.28–2.29). M11, without the OD-9 trend.
16. **Small fixes.** Notification dot only when there is a count (L1); unsorted glyph at 55 % (L2); `prefers-reduced-motion` (L6); tabular figures in confirmation values (L7); 44 px pager on `pointer: coarse` (L8); the "Archivo listo" status clears after 8 s (L10).

## 5. New i18n keys (`packages/i18n/messages/es-419.json` and `en.json`, same keys, rule 24)

| Key | es-419 | en |
|---|---|---|
| `nav.shell.skip_to_content` | Saltar al contenido | Skip to content |
| `nav.shell.assistant_toggle_title` | Mostrar u ocultar el asistente (Ctrl+/ o ⌘/) | Show or hide the assistant (Ctrl+/ or ⌘/) |
| `grid.refreshing` | Actualizando… | Updating… |
| `grid.totals_filtered` | Total del filtro | Filter total |
| `grid.keys_hint` | ↑↓ moverse · Espacio seleccionar · Enter abrir · / filtrar | ↑↓ move · Space select · Enter open · / filter |
| `grid.adv.searching` | Buscando… | Searching… |
| `grid.views.confirm_remove` | ¿Eliminar {name}? | Delete {name}? |
| `grid.import.only_errors` | Solo filas con error ({count}) | Only rows with errors ({count}) |
| `grid.import.progress` | {done} de {total} filas | {done} of {total} rows |
| `common.forms.save_hint` | Ctrl+S guarda | Ctrl+S saves |
| `common.forms.no_match` | Sin coincidencias | No matches |
| `common.live.on` | En vivo | Live |
| `common.live.paused` | En pausa | Paused |
| `common.live.error` | Sin conexión | Offline |
| `common.live.updated` | Actualizado {time} | Updated {time} |
| `common.live.resume` | Reanudar | Resume |
| `agent.ui.answering` | Respondiendo… | Answering… |
| `agent.ui.answer_ready` | Respuesta lista | Answer ready |
| `agent.ui.jump_latest` | Ir al final | Jump to latest |
| `home.kpi.trend` | Tendencia de los últimos {days} días | Trend over the last {days} days |
| `home.kpi.attention` | Revisar | Check |
| `home.dashboard.draggable` | tarjeta movible | movable card |
| `common.admin.pending_changes` | {count, plural, one {# cambio sin aplicar} other {# cambios sin aplicar}} | {count, plural, one {# change not applied} other {# changes not applied}} |
| `common.admin.apply_changes` | Aplicar cambios | Apply changes |
| `common.admin.discard_changes` | Descartar | Discard |
| `common.admin.permissions.all` | todos | all |
| `common.admin.permissions.grant_module` | Dar a {role} todos los procesos de {module} | Give {role} every process of {module} |
| `common.admin.ai_usage.cap_reached` | límite alcanzado: el asistente solo responde consultas | cap reached: the assistant answers questions only |

Every proposal in this report keeps the `$ 1.234.567,00` money format (`formatMoney`), Source Sans 3 / JetBrains Mono, 36 px grid rows, the 400 px drawer, the navy bar and the tinted tabs row. None adds a charting library: the charts are inline SVG on `viewBox` units with `vector-effect: non-scaling-stroke`, filled only from tokens, so they read the same in light, dark and automatic.
