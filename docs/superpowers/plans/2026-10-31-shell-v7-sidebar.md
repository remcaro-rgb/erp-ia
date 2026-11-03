# ERP-IA Shell v7: modules in a left rail, items bar under the top bar, assistant on the right — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Enforcement (owner order, 2026-10-28):** every implementer and reviewer, whatever model runs it, reads `docs/project-rules.md` and the design sections the task touches before starting, and the brief given to any subagent says: "Read `docs/project-rules.md` and the design sections for §19a (UI direction), §22.9 and §22.11 (shell decisions) and §7.1 (assistant) before starting; follow the plan task verbatim." Work that passes its tests but breaks a rule or deviates from the design is rejected. A task that would need a deviation stops and reports.
>
> **Owner order (2026-10-31):** written for review. Do not execute until the owner says so. This plan **changes rule 19 and design §19a** ("No permanent left sidebar", "Módulos menu … items in the top bar"). Task 1 records that change as an owner decision (§22.21) before any code moves; the sub-decisions OD-1–OD-6 below carry the plan's recommendations and need the owner's yes or a different answer.
>
> **Base:** start from a clean `main`. On 2026-10-31 the working tree holds uncommitted edits to `packages/ui/src/styles/components.css`, `grid-page.tsx` and the accounting entry UI; commit or discard them first so this plan's diffs stay reviewable.

**Goal:** Reshape the application shell after the owner's reference prototype (`modern_erp_dashboard (1).html`, 2026-10-31): the entitled modules move to a collapsible left rail, the active module's menu items move to their own bar under the top bar, and the assistant stays docked on the right, without changing any process, permission, page or grid.

**Architecture:** Only the shell in `packages/ui/src/shell` changes layout: a new `ModuleRail` replaces the top bar's Módulos dropdown, the existing `ModuleBar` leaves the top bar and becomes `ItemsBar` in its own band, `TopBar` keeps brand, company, ⌘K, theme, notifications, Asistente and the user menu. The module list still comes from `buildShellNav` (rule 4: entitled and permitted only) and gains one icon per module. The rail's collapsed state is a user preference saved like `assistant.open` (`kernel.user_prefs`, cached in localStorage, newer copy wins).

**Tech Stack:** TypeScript 5.x, Next.js 16 App Router, React 19, Tailwind v4 + the shared `erp-*` stylesheet (OD-8 of §22.11: utilities do not replace it), lucide-react, next-intl, zustand, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-26-erp-ia-design.md` §19a, §22.9, §22.11 (OD-1, OD-6, OD-10), §22.17 (`NavItem.children`), §7.1; rules 4, 19, 24, 25 of `docs/project-rules.md`; the owner's reference prototype (to be copied into the repo by Task 1); prototype v5 `docs/superpowers/specs/2026-10-27-erp-ia-phase1-prototype.html` for everything this plan does not change (record frame, grids, drawer content).

## What changes and what stays

| Area | Today (v5/v6) | Shell v7 |
|---|---|---|
| Modules | `Núcleo ▾` dropdown in the navy top bar | Left rail: icon + name per module, collapsible to icons only |
| Module items | In the top bar, right of the module button | Own band (44 px) under the top bar, over the page column; groups (`Maestros ▾`) unchanged |
| Inicio | First item of the base module's bar | First entry of the rail (house icon), above the modules |
| Tabs row | Tinted band under the top bar, full width | Same component, under the items bar, page column only (OD-2) |
| Assistant | Right drawer, 400 px, pushes the page | Unchanged: docked, 400 px, full height under the top bar (OD-3) |
| Top bar | Brand, company, Módulos, items, ⌘K, theme, bell, Asistente, user | Brand, company, ⌘K (wider), theme, bell, Asistente, user; on phones a menu button opens the rail |
| Colours | Navy bar, blue tokens | Unchanged (OD-1) |

## Owner sub-decisions (recommendations; confirm or change before execution)

- **OD-1 · Palette.** Keep the approved navy top bar and blue tokens of §19a; take the reference's layout, not its indigo/white look. Alternative: a white top bar would change the token table and every screenshot in the guides.
- **OD-2 · Tabs row stays.** Open-screen tabs remain (rule 19, §22.11 OD-6) as a band under the items bar, limited to the page column. Alternative: drop the tabs row (the reference has none), losing persisted tabs.
- **OD-3 · Assistant docked, not overlay.** The drawer keeps pushing the page (today's behaviour, OD-10 start-closed under 1280 px). The reference slides it over the content; an overlay hides grid columns while the user asks about them.
- **OD-4 · Rail widths and default.** Expanded 232 px, collapsed 60 px. With no saved choice: expanded at ≥ 1440 px viewport, collapsed below, decided by CSS on first paint and then once by the shell (the OD-10 pattern). At 1366 px with the drawer open the page keeps 1366 − 60 − 400 = 906 px.
- **OD-5 · Phones (< 768 px).** The rail is hidden; a menu button at the left of the top bar opens it as a sheet over the page; picking a module or Inicio closes it.
- **OD-6 · Not taken from the reference.** No second-level nested dropdowns (`NavItem.children` stays one level, §22.17); no "Nuevo registro" / export buttons in the items bar (creation stays in grids and ⌘K, exports in the grid header per rule 20); no "System status" footer in the rail (no data source). Each can be a later decision.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (§19a, §22.21), `docs/project-rules.md` (rule 19), `docs/roadmap.md` | The owner decision and the new shell contract | 1 |
| `docs/superpowers/specs/2026-10-31-erp-ia-prototype-v7-shell.html` | Prototype v7: the reference's layout in our tokens, es-419 copy and Café del Norte data; the new visual contract for the shell | 1 |
| `packages/kernel/src/registry/types.ts` (`ModuleDef.icon`), `packages/kernel/src/module/kernel-module.ts`, `packages/modules/{core,accounting,support}/src/index.ts` | One icon per module | 2 |
| `packages/ui/src/shell/types.ts` (`ShellModule.icon`), `apps/web/src/lib/shell/nav.ts`, `packages/ui/src/shell/nav-icons.tsx` | Carry and draw the module icon | 2 |
| `packages/ui/src/shell/ModuleRail.tsx` + `__tests__/ModuleRail.test.tsx` | The left rail | 3 |
| `packages/ui/src/shell/ItemsBar.tsx` (renamed from `ModuleBar.tsx`) + `__tests__/items-bar.test.tsx` (renamed from `module-bar.test.tsx`) | The items band | 4 |
| `packages/ui/src/shell/TopBar.tsx`, `AppShell.tsx`, `prefs-cache.ts`, `index.ts`, `__tests__/AppShell.test.tsx` | New layout, rail state and preference | 5 |
| `apps/web/src/lib/prefs/validate.ts`, `apps/web/src/lib/shell/load.ts`, `apps/web/src/app/(app)/_components/web-shell.tsx` | Save and load `shell.rail_collapsed` | 5 |
| `packages/ui/src/styles/tokens.css`, `globals.css`, `components.css` | Rail and items-bar tokens and classes | 3, 4, 5 |
| `packages/i18n/messages/es-419.json`, `en.json` (`nav.shell.*`) | New copy | 3, 4, 5 |
| `apps/web/e2e/shell.spec.ts`, `smoke.spec.ts`, `admin.spec.ts` | End-to-end on the new shell | 5 |
| `docs/user-guide/es-419/navegacion.md`, `asistente.md`, `inicio.md`, `administracion.md` | Guides and screenshots | 6 |

## Global Constraints

- No process, permission, entity, view, migration or grid behaviour changes; a task that needs one stops and reports (rule 32).
- The rail lists only modules that `buildShellNav` returns (entitled and with at least one permitted item, rule 4); a disabled module disappears from the rail exactly as it disappears from today's Módulos menu.
- Every string through `packages/i18n` under `nav.shell.*`, with the same keys in `en.json` (rule 24). Fonts Source Sans 3 / JetBrains Mono; colours only from tokens in `tokens.css`, both themes derived from the same table (§19a); the top bar stays navy in dark mode.
- Nothing moves under the user's feet (rule 25): the rail's collapsed state, like the drawer's, changes only on the user's action and is remembered per user and company; a resize never moves it after the first decision.
- Keyboard and screen readers: the rail is a `<nav aria-label="Módulos">`, the active entry carries `aria-current="page"`; the collapse button has `aria-expanded` and `aria-controls="erp-rail"`; in the collapsed rail each entry keeps its accessible name (`aria-label`) and shows a `title` tooltip; focus ring per `globals.css` (≥ 3:1); 44 px minimum targets on phones (rule 24).
- Dense routes keep OD-1 padding (`.erp-main[data-density="tight"]`); the record page keeps `scroll-padding-top` (`globals.css:105`) correct for the new header height (top bar 48 + items bar 44 + tabs row).
- Tests first (rule 31). Pre-commit gate of every task: `pnpm lint`, `pnpm typecheck`, `pnpm check:rules`, `pnpm -F @erp/ui test`, `pnpm -F web test`, the touched e2e specs against `:3100` (`E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e <spec>`), `pnpm build`. Never `pkill next-server` (another project on `:3000`).
- Commits conventional, one per task, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no commit, push or PR without the owner asking (rule 33).

## Review Focus

1. **Module switching keeps today's semantics.** Picking a module brings its open tab to the front or opens its first item; a pick from a page of another module shows that module's items until the page changes (`selectedModule` in `AppShell.tsx`). Test in Task 5: `picking a module in the rail brings its open tab to the front, else opens its first item`.
2. **Entitlements and permissions still decide what shows.** A module the company lost, or whose items the role cannot open, is absent from the rail in both widths and from the phone sheet. Test in Task 2 (`nav.test.ts`: `a module without visible items has no rail entry`) and Task 3 (`renders exactly the modules it is given`).
3. **The collapsed rail is usable without a mouse.** Every entry reachable by Tab, named for screen readers, `aria-current` on the active one; Enter activates. Test in Task 3: `collapsed: entries keep their names and the active one is marked`.
4. **No layout jump on first paint.** With no saved choice the rail renders in the CSS `auto` state (collapsed below 1440 px by a media query) and the shell resolves it before paint; a saved choice renders explicitly from the server markup. Tests in Task 5: `server markup carries rail auto state when nothing is saved`, `a saved choice renders explicitly`.
5. **Group menus are not clipped.** A `Maestros ▾` group at the right end of a narrow items bar opens its menu fully visible (fixed positioning from the trigger's rect), closes on Escape with focus back on the trigger, and closes when the bar scrolls. Test in Task 4: `group menu is positioned from the trigger and closes on scroll`.

---

### Task 1: Owner decision, design and rules, prototype v7

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (§19a Shell bullets; new §22.21)
- Modify: `docs/project-rules.md` (rule 19; header date)
- Modify: `docs/roadmap.md` (Phase 2 section: a "Shell v7" line between 2A and 2B)
- Create: `docs/superpowers/specs/2026-10-31-erp-ia-prototype-v7-shell.html`
- Create: `docs/superpowers/specs/2026-10-31-reference-modern-erp-dashboard.html` (verbatim copy of the owner's file, for traceability)

**Interfaces:** Produces the contract the later tasks implement; no code.

- [ ] **Step 1: Record §22.21** "Shell v7 (2026-10-31)": modules in a collapsible left rail (232 / 60 px, Inicio first), the active module's items in a 44 px band under the top bar, tabs row under it in the page column, assistant drawer unchanged, the rail state saved per user (`shell.rail_collapsed`), plus OD-1–OD-6 as the owner answered them. Mark "No permanent left sidebar" and the v5.4 "items sit in the top bar" of §19a as superseded by §22.21 (strike the sentence and point to §22.21; do not delete history).
- [ ] **Step 2: Rewrite rule 19** to: "The shell is the approved one (design §19a as revised by §22.21, prototype v7): navy top bar with company switcher, ⌘K, theme, notifications, Asistente and user menu; a collapsible left rail listing Inicio and the modules only; the active module's items in a band under the top bar; the tinted tabs row under it; assistant drawer of 400 px; light / dark / automatic theme from one token table." Update the header date line ("rule 19 updated 2026-10-31").
- [ ] **Step 3: Build prototype v7** from the reference's structure (header 48 px, rail, items band, workspace, docked assistant) using `tokens.css` values, Source Sans 3, es-419 copy (`Núcleo`, `Contabilidad`, `Soporte`, `Sistema`; Contabilidad items `Comprobantes · Movimientos · Reportes · Periodos · Maestros ▾`) and the home with Café del Norte KPIs. Self-contained HTML, no CDN Tailwind; collapse and phone sheet work in the file.
- [ ] **Step 4: Verify** the prototype opens in the browser pane at 1440, 1366 and 375 px, both themes; screenshot each into the review notes (not the repo).
- [ ] **Step 5: Commit** `docs(shell): owner decision §22.21 shell v7, rule 19 and prototype v7`.

### Task 2: One icon per module

**Files:**
- Modify: `packages/kernel/src/registry/types.ts` (`ModuleDef`)
- Modify: `packages/kernel/src/module/kernel-module.ts`, `packages/modules/core/src/index.ts`, `packages/modules/accounting/src/index.ts`, `packages/modules/support/src/index.ts`
- Modify: `packages/ui/src/shell/types.ts`, `packages/ui/src/shell/nav-icons.tsx`, `apps/web/src/lib/shell/nav.ts`
- Test: `apps/web/src/lib/shell/nav.test.ts`, `packages/ui/src/shell/__tests__/nav-icons.test.tsx` (new)

**Interfaces:**
- Produces: `ModuleDef.icon?: string` (a `NAV_ICONS` name); `ShellModule { id: string; label: string; icon: string }` (`"grid"` when the module declares none); `NAV_ICONS` gains `home` (House), `calculator` (Calculator), `settings` (Settings).
- Icons: kernel `settings`, core `building`, accounting `calculator`, support `life-buoy`.

- [ ] **Step 1: Write the failing tests.** In `nav.test.ts` extend `with everything granted…`: the `shell.modules` assertion becomes `[{ id: "core", label: "nav.modules.core", icon: "building" }, { id: "kernel", label: "nav.modules.kernel", icon: "settings" }]`; add `a module without visible items has no rail entry` asserting a module whose items are all unpermitted is absent from `modules`. In `nav-icons.test.tsx`: `NavIcon name="calculator"` renders an `svg` with class `lucide-calculator`; an unknown name renders `lucide-circle`.
- [ ] **Step 2: Run** `pnpm -F web test src/lib/shell/nav.test.ts` and `pnpm -F @erp/ui test nav-icons` — expect FAIL (`icon` undefined, `lucide-circle`).
- [ ] **Step 3: Implement**: add the field with a doc comment, set the four icons, `modules.push({ id, label, icon: mod.icon ?? "grid" })`, add the three icons to `NAV_ICONS`.
- [ ] **Step 4: Run** the two test files and `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(kernel): modules declare an icon for the shell rail`.

### Task 3: `ModuleRail`

**Files:**
- Create: `packages/ui/src/shell/ModuleRail.tsx`
- Test: `packages/ui/src/shell/__tests__/ModuleRail.test.tsx`
- Modify: `packages/ui/src/styles/tokens.css`, `globals.css` (Tailwind color aliases), `components.css` (`.erp-rail*`), `packages/i18n/messages/{es-419,en}.json`

**Interfaces:**
- Consumes: `ShellModule` with `icon` (Task 2), `NavIcon`.
- Produces:
```ts
export interface ModuleRailProps {
  modules: ShellModule[];               // already filtered by the shell
  activeModuleId: string | undefined;   // undefined while Inicio is shown
  homeActive: boolean;                  // currentHref === "/"
  collapsed: boolean;
  auto?: boolean;                       // no saved choice: CSS decides (data-rail="auto")
  onSelectModule(moduleId: string): void;
  onHome(): void;
  onToggleCollapsed(): void;
  variant?: "docked" | "sheet";         // "sheet" = phone overlay (Task 5)
}
export function ModuleRail(props: ModuleRailProps): JSX.Element;
```
- Markup: `<aside id="erp-rail" class="erp-rail" data-collapsed={collapsed}>` › header row with the label `nav.shell.rail_title` ("Módulos", hidden when collapsed) and the toggle button › `<nav aria-label={t("nav.shell.modules")}>` with Inicio then one `<button>` per module (icon + label).
- Tokens (light / dark): `--rail` #FFFFFF / #141B2E, `--rail-line` = `--line` / `--line`, `--rail-text` = `--text-muted`, `--rail-active` = `var(--accent)` (#DBEAFE light / #1E3A8A dark), `--rail-active-text` = `var(--link)`. Widths `--rail-w: 232px`, `--rail-w-collapsed: 60px`; entry height 40 px (44 px under 768 px); width transition 150 ms, none under `prefers-reduced-motion`.
- Copy (es-419 / en): `nav.shell.rail_title` "Módulos" / "Modules"; `nav.shell.rail_collapse` "Contraer menú" / "Collapse menu"; `nav.shell.rail_expand` "Expandir menú" / "Expand menu".

- [ ] **Step 1: Write the failing tests** in `ModuleRail.test.tsx` (wrap in `NextIntlClientProvider` like `module-bar.test.tsx`):
  - `renders Inicio then exactly the modules it is given` — names `["Inicio", "Núcleo", "Contabilidad"]` for two modules.
  - `marks the active module, or Inicio on the home` — `aria-current="page"` on Contabilidad when `activeModuleId="accounting"`; only on Inicio when `homeActive`.
  - `picking calls back` — click Contabilidad → `onSelectModule("accounting")`; click Inicio → `onHome()`.
  - `the toggle says its state` — expanded: button named "Contraer menú", `aria-expanded="true"`, `aria-controls="erp-rail"`; click → `onToggleCollapsed`.
  - `collapsed: entries keep their names and the active one is marked` — with `collapsed`, `getByRole("button", { name: "Contabilidad" })` still found (via `aria-label`), has `title="Contabilidad"`, label text not rendered visibly (`.erp-rail__label` absent), toggle named "Expandir menú" with `aria-expanded="false"`.
  - `auto state is left to CSS` — `auto` renders `data-rail="auto"` and no `data-collapsed`.
- [ ] **Step 2: Run** `pnpm -F @erp/ui test ModuleRail` — FAIL (module not found).
- [ ] **Step 3: Implement** the component, tokens, classes and copy. `@media (max-width: 1439px) { #erp-rail[data-rail="auto"] { width: var(--rail-w-collapsed) } }` and hide `.erp-rail__label` in the same state.
- [ ] **Step 4: Run** the tests — PASS; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(ui): module rail for the shell`.

### Task 4: `ItemsBar` (the module items band)

**Files:**
- Rename: `packages/ui/src/shell/ModuleBar.tsx` → `ItemsBar.tsx`; `__tests__/module-bar.test.tsx` → `__tests__/items-bar.test.tsx`
- Modify: `packages/ui/src/styles/components.css` (`.erp-modbar-*` → `.erp-itemsbar*`), `tokens.css`, `packages/ui/src/shell/index.ts`

**Interfaces:**
- Produces: `ItemsBar(props: ItemsBarProps)` with `ItemsBarProps = { items: NavItem[]; heading?: string; activeHref: string; onNavigate(target: { href: string; title: string; kind: "grid" }): void }`. `showHome` is removed (Inicio moved to the rail); `heading` is shown instead of items when `items` is empty (Inicio: "Inicio"). `isActiveHref` keeps its name and export (AppShell imports it).
- Band: `<nav aria-label={t("nav.shell.module_menu")} class="erp-itemsbar">`, height 44 px, `--surface` background, bottom border `--line`; items are pills (radius 6 px, 13 px text, active = `--head` background + `--primary` text + 1 px `--line` border, per the reference's active style in our tokens); the bar scrolls sideways (`overflow-x: auto`, no visible scrollbar) when items do not fit.
- Group menu: `position: fixed`, `top = trigger.bottom + 4`, `left = min(trigger.left, innerWidth − menuWidth − 8)`, computed on open; closes on Escape (focus back on trigger), outside press, Tab, and on the bar's `scroll` or window `resize`. The 760 px media rule for `.erp-modbar-menu` is dropped (fixed positioning covers it).

- [ ] **Step 1: Move the two existing tests** to `items-bar.test.tsx` against `ItemsBar` (drop `showHome`) and add:
  - `shows the heading when there are no items` — `items=[]`, `heading="Inicio"` → text "Inicio", no buttons.
  - `group menu is positioned from the trigger and closes on scroll` — mock the trigger's `getBoundingClientRect` to `{ left: 900, bottom: 92, … }` with `innerWidth = 1000`; open → menu `style.position === "fixed"`, `style.top === "96px"`, `style.left` ≤ `1000 − 8 − menuWidth` (mock the menu's `offsetWidth = 200` → `"792px"`); `fireEvent.scroll(nav)` → no `menu`.
- [ ] **Step 2: Run** `pnpm -F @erp/ui test items-bar` — FAIL.
- [ ] **Step 3: Implement** the rename (update imports in `AppShell.tsx`, `TopBar.tsx`, `index.ts`: export `ItemsBar`, `ItemsBarProps`, `isActiveHref`; remove `ModuleBar` exports), the band styles and the fixed-position menu.
- [ ] **Step 4: Run** `pnpm -F @erp/ui test` (whole package: TopBar/AppShell tests still compile) and `pnpm typecheck` — PASS except the AppShell assertions Task 5 rewrites; if any fail, note them for Task 5, do not edit them here.
- [ ] **Step 5: Commit** `refactor(ui): module items move to their own bar`.

### Task 5: Shell layout, top bar, rail preference, end-to-end

**Files:**
- Modify: `packages/ui/src/shell/AppShell.tsx`, `TopBar.tsx`, `prefs-cache.ts`, `index.ts`
- Modify: `packages/ui/src/styles/components.css`, `globals.css` (`scroll-padding-top`)
- Modify: `apps/web/src/lib/prefs/validate.ts` (+ `validate.test.ts`), `apps/web/src/lib/shell/load.ts`, `apps/web/src/app/(app)/_components/web-shell.tsx`
- Modify: `packages/i18n/messages/{es-419,en}.json`
- Test: `packages/ui/src/shell/__tests__/AppShell.test.tsx`, `apps/web/e2e/shell.spec.ts`, `smoke.spec.ts`, `admin.spec.ts`

**Interfaces:**
- Consumes: `ModuleRail` (Task 3), `ItemsBar` (Task 4).
- Produces:
  - `AppShellProps.railCollapsed?: Saved<boolean> | null` and `onRailCollapsedChange?: (collapsed: boolean, savedAt: number) => void` (same contract as `assistantOpen`).
  - `railCollapsedStorageKey(userId: string): string` in `prefs-cache.ts`.
  - `ShellPrefKey` gains `"shell.rail_collapsed"` (boolean, like `assistant.open`).
  - `TopBarProps` loses `modules`, `itemsByModule`, `activeModuleId`, `onSelectModule`, `activeHref`, `onNavigate`; gains `onOpenRail?: () => void` (phone menu button, rendered only under 768 px via CSS, `aria-label={t("nav.shell.rail_open")}` "Abrir menú" / "Open menu", `aria-controls="erp-rail"`).
- Layout (inside the existing providers):
```
<div flex-col h-dvh>
  <TopBar/>                                   48 px
  <div flex min-h-0 flex-1>
    <ModuleRail/>                             232 | 60 px (hidden < 768 px; sheet when opened)
    <div flex-col min-w-0 flex-1>
      <ItemsBar/>                             44 px
      <TabsBar/>
      <main id="erp-main" class="erp-main"/>
    </div>
    <AssistantDrawer/>                        400 px, unchanged
  </div>
</div>
```
- Behaviour: `homeActive = currentHref === "/"`; on the home the items bar gets `items=[]`, `heading=t("nav.shell.home")`; elsewhere the active module's `menu !== false` items. Rail `onHome` → `navigate("/")`. `selectModule` unchanged. Rail collapsed: saved choice (server copy or newer browser cache) else `window.innerWidth >= 1440` → expanded, decided once in `useLayoutEffect`, with the CSS `auto` state until then (mirror the drawer code: `railCollapsed`, `railAuto`, `chooseRail`). Phone sheet: `sheetOpen` state; rendered as `variant="sheet"` with a backdrop, closes on pick, Escape, backdrop click; not saved.
- `scroll-padding-top` for the record page becomes the sum of the sticky record header plus nothing above it inside `#erp-main` (the bars are outside the scroller); verify the value in the browser rather than guessing, and pin it in a comment.

- [ ] **Step 1: Rewrite the failing tests** in `AppShell.test.tsx`:
  - Replace `shows the active module's items next to the module button…` with `the rail lists Inicio and the modules, the items bar the active module's items` (rail `navigation` "Módulos" has `Inicio, Núcleo, Sistema`; items `navigation` "Menú del módulo" has the core items, no Inicio).
  - Replace `the Módulos menu lists modules only…` / `choosing another module in the Módulos menu…` / `choosing a module with no open tab…` with `picking a module in the rail brings its open tab to the front, else opens its first item` (same assertions, rail clicks).
  - Add `on the home the rail marks Inicio and the items bar shows its heading`.
  - Add the rail-preference block mirroring the drawer block (`describe("rail")`): `collapsed at 1200 px and expanded at 1500 px`, `a stored preference wins over the width, both ways`, `this browser's cache wins over the server's copy when it is newer`, `saves a user's toggle with its time and caches it, but not the default`, `server markup carries rail auto state when nothing is saved`, `a saved choice renders explicitly`.
  - Add `the phone menu button opens the rail as a sheet that closes on pick and on Escape`.
  - In `validate.test.ts`: `shell.rail_collapsed accepts a boolean and refuses anything else`.
- [ ] **Step 2: Run** `pnpm -F @erp/ui test AppShell` and `pnpm -F web test src/lib/prefs` — FAIL.
- [ ] **Step 3: Implement** layout, top bar slimming (⌘K box widens to 280 px), rail state and preference end to end (`validate.ts`, `load.ts` reads `shell.rail_collapsed` like `assistant.open`, `web-shell.tsx` passes it and saves changes through the same server action/beacon), copy.
- [ ] **Step 4: Run** the unit tests — PASS.
- [ ] **Step 5: Update the e2e specs** that read the top bar: `shell.spec.ts:47-52` (module button in the header → rail entry `Núcleo` with `aria-current`; items via `getByRole("navigation", { name: "Menú del módulo" })` without scoping to `header`), and the matching lines in `smoke.spec.ts` and `admin.spec.ts` (`grep -n "Menú del módulo\|locator(\"header\")\|title\", \"Módulos\"" apps/web/e2e`). Add to `shell.spec.ts`: `the rail collapses, stays collapsed after a reload and expands again`, and at a 375 × 812 viewport `the phone menu opens the rail and a pick navigates`.
- [ ] **Step 6: Run** `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e shell smoke admin` (dev server started with preview tools on `:3100`) — PASS. Then the full gate: lint, typecheck, check:rules, unit, build. Screenshot 1440 px light, 1440 px dark, 1366 px with drawer, 375 px with sheet open; compare with prototype v7.
- [ ] **Step 7: Commit** `feat(ui): shell v7 layout with module rail and items bar`.

### Task 6: User guides

**Files:**
- Modify: `docs/user-guide/es-419/navegacion.md` (sections "La barra de arriba" → "La barra de arriba", "El menú de módulos (izquierda)", "La barra de opciones del módulo", "Las pestañas"; phone behaviour), `asistente.md` (where the button and panel are), `inicio.md` (Inicio is in the left menu), `administracion.md` (where "Sistema" now lives)
- Modify: the screenshots these guides embed (recapture from the demo company with the same script the gaps plan's Task 10 used)
- Test: `packages/kernel/src/help/__tests__/` (the existing guide-chunking tests must still pass)

**Interfaces:** Consumes the shipped shell (Task 5). Produces nothing for code.

- [ ] **Step 1: Write** the guide changes in es-419, describing exactly the copy shipped in Task 5 ("Contraer menú", "Expandir menú", "Abrir menú", "Módulos", "Menú del módulo"); remove every mention of the Módulos dropdown and of options "a la derecha del botón de módulo".
- [ ] **Step 2: Recapture** the affected screenshots at 1440 × 900 light theme.
- [ ] **Step 3: Run** `pnpm -F @erp/kernel test help` and `pnpm check:rules` — PASS (no `[Captura: …]` placeholder left, guide front-matter routes unchanged).
- [ ] **Step 4: Commit** `docs(guide): navigation guides for the shell v7`.

---

## Execution notes

- Tasks run in order: 1 → 2 → 3 → 4 → 5 → 6. Tasks 2, 3 and 4 touch different files and may run in parallel once Task 1 is approved; Task 5 needs all three.
- Estimated size: Task 5 is the largest (≈ 40 % of the work); the others are small.
- Out of scope, candidates for later owner decisions: nested item menus (OD-6), page actions in the items bar, a rail footer, the reference's indigo palette (OD-1), adaptive UI suggestions placed in the rail (phase 3).
