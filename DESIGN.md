---
name: Heddle
description: >-
  Operator dashboard for Heddle. It uses the visual language of T3 Code so that
  a T3 Code user reads it without learning a new vocabulary.
source: T3 Code web client (apps/web/src/index.css, components/ui)
colors:
  light:
    background: "#fcfcfc"
    sidebar: "#fafafa"
    card: "#ffffff"
    popover: "#ffffff"
    accent: "#f4f4f5"
    border: "#e4e4e7"
    input: "#d4d4d8"
    foreground: "#27272a"
    muted-foreground: "#71717a"
    icon-muted: "#8b8b93"
    primary: "#1b4ed8"
    primary-foreground: "#ffffff"
    success: "#10b981"
    success-foreground: "#047857"
    warning: "#f59e0b"
    warning-foreground: "#b45309"
    error: "#ef4444"
    error-foreground: "#b91c1c"
    info: "#3b82f6"
    info-foreground: "#1d4ed8"
    lane: "#f4f4f5"
    tile: "#ffffff"
    edge: "#a1a1aa"
    grid: "#e9e9ec"
  dark:
    background: "#0a0a0a"
    sidebar: "#111111"
    card: "#111111"
    popover: "#141414"
    accent: "#1c1c1c"
    border: "#1f1f1f"
    input: "#2a2a2a"
    foreground: "#f5f5f5"
    muted-foreground: "#8a8a8a"
    icon-muted: "#7a7a7a"
    primary: "#346bf1"
    primary-foreground: "#ffffff"
    success: "#10b981"
    success-foreground: "#34d399"
    warning: "#f59e0b"
    warning-foreground: "#fbbf24"
    error: "#ef4444"
    error-foreground: "#f87171"
    info: "#3b82f6"
    info-foreground: "#60a5fa"
    lane: "#0e0e0e"
    tile: "#141414"
    edge: "#3f3f46"
    grid: "#1a1a1a"
typography:
  font-sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
  font-mono: 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace'
  page-title: { fontSize: 18px, fontWeight: 600, letterSpacing: -0.01em }
  dialog-title: { fontSize: 16px, fontWeight: 600 }
  body: { fontSize: 14px, fontWeight: 400 }
  control: { fontSize: 14px, fontWeight: 500 }
  secondary: { fontSize: 13px, fontWeight: 400 }
  label: { fontSize: 12px, fontWeight: 500 }
  badge: { fontSize: 11px, fontWeight: 500 }
  mono: { fontFamily: "{typography.font-mono}", fontSize: 12.5px }
rounded:
  sm: 6px
  control: 8px
  lg: 10px
  dialog: 14px
  full: 9999px
spacing:
  unit: 4px
  header-height: 52px
  sidebar-width: 256px
  sidebar-rail-width: 48px
  nav-row-height: 32px
  control-height: 32px
  control-height-sm: 28px
  table-head-height: 40px
  table-row-height: 52px
  page-padding: 28px 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    height: "{spacing.control-height}"
    rounded: "{rounded.control}"
  button-outline:
    backgroundColor: "{colors.card}"
    borderColor: "{colors.input}"
    textColor: "{colors.foreground}"
    height: "{spacing.control-height}"
    rounded: "{rounded.control}"
  button-ghost:
    backgroundColor: transparent
    hoverBackgroundColor: "{colors.accent}"
    iconColor: "{colors.icon-muted}"
  button-destructive-outline:
    backgroundColor: "{colors.card}"
    borderColor: "{colors.input}"
    textColor: "{colors.error-foreground}"
  badge:
    height: 18px
    rounded: "{rounded.sm}"
    typography: "{typography.badge}"
  status-dot:
    size: 8px
    rounded: "{rounded.full}"
  table:
    container: "{colors.card} with 1px {colors.border}, {rounded.lg}"
    headRowBackground: "{colors.sidebar}"
    headTypography: "{typography.label}"
  dialog:
    backgroundColor: "{colors.popover}"
    rounded: "{rounded.dialog}"
    width: 440px
  lane:
    backgroundColor: "{colors.lane}"
    width: 264px
    rounded: "{rounded.lg}"
  task-node:
    backgroundColor: "{colors.tile}"
    borderColor: "{colors.border}"
    rounded: "{rounded.control}"
    width: 152px
    height: 84px
  graph-edge:
    strokeColor: "{colors.edge}"
    strokeWidth: 1.5px
    criticalStrokeColor: "{colors.primary}"
    criticalStrokeWidth: 2px
  task-card:
    backgroundColor: "{colors.tile}"
    borderColor: "{colors.border}"
    rounded: "{rounded.control}"
    padding: 10px 12px
---

# Heddle design

## Overview

Heddle is an operator console for work that runs on T3 Code. The design uses
T3 Code's own tokens, primitives, and density, so that a T3 Code user sees the
same surfaces, controls, and status language in both products.

The look is quiet and compact. Neutral surfaces carry the content. Color
appears only for the primary action and for state (connected, paused, failed).
There is no decoration: no gradients, no illustration, no brand color in
backgrounds.

Heddle supports light and dark themes and follows the system setting by
default, as T3 Code does.

## Colors

The token names are T3 Code's semantic names. The hex values in the front
matter are the resolved values of T3 Code's defaults. The source of truth is
T3 Code's `index.css`; when T3 Code changes a default, change it here.

- **Neutrals.** Light theme uses the zinc scale on a near-white background.
  Dark theme uses near-black neutrals, with surfaces made by mixing a small
  percentage of white into the background.
- **Primary.** One blue (`oklch(0.488 0.217 264)` light,
  `oklch(0.571 0.21 264)` dark). Use it for the one main action in a view and
  for focus rings. Do not use it for status.
- **Status.** Success is emerald, warning is amber, error is red, info is
  blue. A status fill (dot, solid badge) uses the base color. Status text uses
  the `-foreground` variant, so that text keeps a 4.5:1 contrast.
- **Tinted surfaces.** Badges and alerts use the status color at 8% (light) or
  16% (dark) opacity behind `-foreground` text.

## Typography

Heddle uses the system sans stack, the same as T3 Code. There is no web font.
Use the mono stack for values that an operator copies or compares: host names,
URLs, thread and run IDs, commit SHAs.

Use numbers with `font-variant-numeric: tabular-nums` in tables and counters,
and align them to the right.

The type scale is small. A page title is 18px. Most text is 13–14px. Column
heads and captions are 12px in `muted-foreground`.

## Layout

The application frame has three regions:

1. **Header.** Full width, 52px, above the sidebar and the content. From left
   to right: sidebar toggle, Heddle mark and name, breadcrumb, flexible
   space, command search (⌘K), theme toggle. A bottom border separates it
   from the content.
2. **Sidebar.** 256px wide when expanded, a 48px icon rail when collapsed.
   The header toggle changes the mode. In the rail, each item shows only its
   icon and has an `aria-label`. Group labels become 1px dividers. The width
   change animates for 160ms with `cubic-bezier(0.4, 0, 0.2, 1)`.
3. **Content.** Fills the remaining space and scrolls by itself. Padding is
   28px top and bottom, 32px left and right. A page starts with a title row:
   title and one-line description on the left, the primary action on the
   right.

Spacing is on a 4px grid. Stacks use `gap`, not margins.

## Elevation and depth

Surfaces are separated by 1px borders, not shadows. Only these elements have a
shadow:

- The primary button: a 1px white inset highlight at 16% and a 1px drop
  shadow.
- The selected sidebar item in light theme: a 1px border ring and a 2px
  shadow, so that white-on-near-white stays visible.
- Dialogs and popovers: a large soft shadow over a scrim (black at 60% dark,
  32% light).

## Shapes

- 6px: badges, keyboard hints.
- 8px: buttons, inputs, sidebar items (T3 Code's `--control-radius`).
- 10px: cards and table containers (T3 Code's `--radius`).
- 14px: dialogs.
- Status dots are circles.

## Components

### Buttons

Heights are 32px for page actions and 28px inside table rows. Text is 14px
(13px in rows), weight 500. An icon sits before the label at 14–16px.

- **Primary**: the one main action in a view ("Add environment").
- **Outline**: row actions and secondary actions ("Pause", "Disconnect",
  "Cancel").
- **Ghost**: icon-only controls in the header and dialog title. Each has an
  `aria-label`.
- **Destructive outline**: actions that remove data ("Forget"). The label is
  error-colored; the fill stays neutral so that a list of rows does not become
  a wall of red.

Pressed buttons scale to 0.97. Disabled buttons use 64% opacity. On touch
pointers every control has a hit area of at least 44×44px, as in T3 Code.

### Status

A connection status is an 8px dot plus a text label. Never use the color
alone.

| State        | Dot               | Label color        |
| ------------ | ----------------- | ------------------ |
| Connected    | success           | foreground         |
| Reconnecting | warning, pinging  | foreground         |
| Disconnected | muted, 40%        | muted-foreground   |
| Error        | error             | error-foreground   |

A condition that is independent of the connection, such as "Paused", is a
warning badge after the label.

### Tables

A table sits in a card with a 1px border and 10px radius. The head row is 40px
on the sidebar color, with 12px, weight 500, muted labels. Body rows are 52px
with a 1px border between them and no border after the last row. Cells have
16px horizontal padding. Row actions are right-aligned. A caption under the
table gives totals in 12px muted text.

When a table has no rows, show an empty state in its place: a dashed border,
an icon, a one-line title, and a one-line explanation.

### Dialogs

440px wide, 14px radius. The title row has the title, a one-line description,
and a ghost close button. Fields stack with 16px between them; each has a
visible `<label>`. The footer has a top border, a tinted background, and the
buttons right-aligned: secondary first, primary last.

### Icons

Use Lucide icons (T3 Code uses `lucide-react`), 16px in navigation and
headers, 14px in row buttons, stroke width 2, color `icon-muted` unless the
item is selected.

## Screens

### Sidebar

- No label: Overview, Board, Epics, Runs.
- **Plan**: Portfolio.
- **Configure**: Blueprints, Task fields, GitHub Projects, Environments.

Settings is at the bottom of the sidebar. Overview is the default screen.

These are not in the sidebar. The operator opens them from another screen, and
the header breadcrumb shows the path:

- Task: from a Board card, an Epics node, or a Runs row.
- Run detail: from Runs.
- Blueprint editor: from Blueprints.
- Project template and onboarding: from GitHub Projects.
- Portfolio item edit: from Portfolio.

Heddle uses T3 Code's words. A T3 Code server is an **environment**, and a T3
Code project is a workspace folder, so the GitHub screen is "GitHub Projects",
never "Projects".

### Overview

The shell reference screen. From top to bottom:

- Title row: "Overview" and a one-line description. No primary action.
- Four stat tiles: active runs, items that need attention, the budget source
  closest to its limit (with a meter), and environments connected.
- Active runs table: task title with reference and blueprint, portfolio item,
  active node with its state, elapsed time, and a link to the thread.
- Needs attention list: escalations, failed runs, and paused environments.
  Each item has an icon, a title, one line of detail, and one link.
- API budget this month: one meter per portfolio item. At 85% or more the
  fill changes to warning and a "Near limit" badge appears.

### Board

Tasks in lanes by lifecycle state. A lane is a lifecycle state, not a
blueprint stage: the GitHub Project template maps its status values to
lifecycle states. The active node of a task's run shows on its card.

- Title row: "Board" and a one-line description. No primary action.
- Filters in one row: Portfolio item, Root task, and "Clear filters" when a
  filter is set. The task count is right-aligned in the same row.
- Lanes are 264px wide with a 40px header (name and count badge). The board
  scrolls horizontally; each lane scrolls vertically.
- Cards are ordered by priority, highest first. An empty lane shows
  "No tasks" in a dashed box.
- A card opens the Task page.
- Each lane can collapse to a 44px strip that shows an expand icon, the count,
  and the lane name set vertically. The lane header has a ghost collapse
  button. Backlog is collapsed by default. Each operator's collapsed lanes
  are kept between visits.
- The only manual move is from Backlog to Ready. Heddle moves a task through
  every other lifecycle state. A Backlog card can be dragged; while it is
  dragged, Ready gets a dashed primary border and a "Drop to move to Ready"
  target, and the other lanes fade to 50%. The same move is available from
  the keyboard as "Move to Ready" in the card's context menu.

A task card has, from top to bottom:

1. Priority badge (P0 and P1 on the accent surface in foreground text, lower
   priorities muted), the task reference in mono, and "done" time with a check
   in the Done lane.
2. Title, 13px weight 500, at most two lines.
3. Portfolio item and root task, 12px muted.
4. Run row, only when the task has an active run: status dot, active node in
   mono, run state, and an "Escalated" (warning) or "Failed" (error) badge.

### Epics

A dependency graph of the tasks under one root task. It reads left to right:
a task sits to the right of every task it waits on. "Waits on" is GitHub's
issue dependency ("blocked by"); Heddle keeps no dependency data of its own.

- Title row: "Epics" and a one-line description.
- Toolbar: a Root task select, a summary (tasks, done, open), and two
  switches on the right: "Critical path" and "Fade completed". Both are on by
  default.
- The graph sits in a card on a dotted grid, with zoom controls at the bottom
  left and a legend at the bottom right. Under the graph is a 56px selection
  bar.

A task node is 152×84px: a status mark and the reference, an "Escalated" or
"Failed" badge when that applies, the title in at most two lines, and the
lifecycle state with the active blueprint node. A done task shows a check and
a muted title. An open task with no run shows a hollow dot.

**Critical path.** Agents do the work, so durations and estimates do not
drive the graph. The critical path is the dependency chain with the most open
tasks; done tasks count as zero. When two chains tie, the longer chain wins.
Critical edges are 2px primary; other edges are 1.5px `edge`.

**Focus.** Everything that is not in focus fades: nodes to 30%, edges to 10%.
Transitions take 150ms.

- Hover or keyboard focus on a task: focus is the task, the tasks it waits
  on, and the tasks that wait on it.
- Select a task (click, or Enter on a focused node): focus is the critical
  path through that task: the chain of most open tasks before it, the task,
  and the chain of most open tasks after it. The selection bar shows the
  chain, its open count, "Clear", and "Open task". Clicking the selected
  task again clears the selection.
- With no hover and no selection, "Critical path" highlights the root task's
  critical path, and "Fade completed" fades edges that leave done tasks (25%)
  and done nodes (55%).

### Portfolio

Portfolio items and their share of the budget.

**Budget sources.** Usage draws from one or more budget sources:

- An API budget: dollars over a calendar month, with a reset day.
- A subscription: usage windows set by the provider: a rolling 5-hour window,
  a weekly window, and weekly caps on single models (for example, one model
  may use at most 50% of the weekly window). A provider can grant a reset
  that the operator may use before it expires.

Heddle watches reported usage and detects resets, including early resets by
the provider. Reset times are estimates from that data and read "Resets in
about …".

**One share for every source.** An item's share applies to each source: a 45%
item may use 45% of the API budget and 45% of each subscription window. A run
counts against the source it draws from.

**Cost.** Dollars are the common unit. API usage is its billed cost.
Subscription usage is priced at the provider's API rates from the LiteLLM
model price table, using the input, output, and cache token counts the
provider reports.

#### Portfolio table

- Title row: "Portfolio", a one-line description, "Edit budgets" (outline),
  and "Add item" (primary).
- Budget source cards, one per source: name, kind, one meter per window with
  its value and estimated reset, a granted-reset badge with its expiry, and a
  note when an early reset was detected.
- Columns: Name, Budget (share and API amount), Current usage (one meter per
  source against the item's share of it: dollars for the API budget, the
  weekly window for a subscription), Lifetime cost, Active tasks, Completed
  tasks, and an Edit icon button. A total row closes the table.
- A usage meter at 85% or more of the item's share is warning and shows
  "Near limit".
- An item with sub-budgets has a chevron that shows them as indented rows on
  the `lane` surface, with the same columns.

#### Edit budgets

"Edit budgets" turns every share into a number input and swaps the title-row
buttons for "Cancel" and "Save budgets". A status bar above the table shows
the sum: success when it is 100%, error when it is not, with the sum in the
message. While the sum is not 100%, the share inputs have error borders, the
total share is error-colored, and "Save budgets" is disabled. Sub-budget rows
hide while editing.

#### Edit item

A 480px dialog: Name, the item's share of every source (read-only; shares
change only in Edit budgets), and Sub-budgets. A sub-budget is a root task
with a share of the item's budget; "Other" takes every task outside the
listed root tasks. Each sub-budget row has its amount, a share input, and a
remove button. "Add sub-budget" appends the next root task. The sub-budget
total shows next to the heading and follows the same rule: when there are
sub-budgets, they add up to 100% or "Save" is disabled.

"Add item" opens the same dialog with only a name. A new item starts at 0%.

### Runs

A list of blueprint runs. A run opens as its own page under Runs; the header
breadcrumb shows "Runs / #ref run", and "Runs" in it returns to the list.

#### Runs list

- Title row: "Runs" and a one-line description. No primary action.
- Filters in one row: an Active / Completed segmented control, then
  Portfolio item, Blueprint, and Environment selects. The run count is
  right-aligned.
- Columns: Task (title, reference in mono), Portfolio item, Blueprint (mono),
  Active node (status dot, node in mono, state, and a thread link icon for an
  active run; "Last node" in Completed), Usage (tokens over dollars), Time,
  and Timeline.
- The Timeline cell is a mini bar: one segment per node visit, width by time,
  2px gaps. Completed visits use `edge`; the current visit is primary
  (45% opacity while it waits on a turn); an escalated visit is warning and a
  failed one is error. Each segment has a tooltip with the node and its time.
- A row opens the run.

#### Run page

- Header: "All runs" back link; the reference and title; a status badge
  (Running, Completed, Failed); a meta line with portfolio item, blueprint,
  environment, and start time. On the right: a Timeline / Sequence segmented
  control and "Open thread".
- Four tiles: Tokens, Cost, Time, Passes.
- **Timeline** view: one row per node visit with the node and pass on the
  left, a bar on a shared time axis, the visit's result after the bar
  ("handoff", "idle → retry", "running"), and usage on the right. A dashed
  primary line marks now. A pass that ends without a handoff is warning. A
  total row closes the table.
- **Sequence** view: lifelines for Heddle, the T3 Code thread, and GitHub.
  Heddle's messages are solid arrows; replies are dashed. A pass either
  starts a thread ("Start thread") or continues one the run already has
  ("Continue thread"), as the blueprint decides. An abnormal reply,
  such as "idle", is warning. The pass that is running is a note on the
  thread's lifeline. Usage sits in a right-hand column on the row of the
  reply that closed each pass.

### Environments

- Title row: "Environments", description, and the primary "Add environment"
  button.
- Table columns: Host (mono), Status, Active threads, Scheduled threads,
  Actions.
- Row actions: Pause / Resume, Disconnect / Reconnect, Forget.
- Active threads shows "—" for a disconnected environment, because the count
  is not known.
- "Add environment" opens a dialog with the server URL and the credential
  the environment requires.

## Implementation

Heddle's UI is a React application built on the same stack as T3 Code's web
client: Tailwind CSS v4, Base UI primitives, class-variance-authority for
variants, lucide-react for icons, dnd-kit for drag and drop (pointer,
touch, and keyboard), and ReactFlow (`@xyflow/react`) for graphs. The Epics
graph and the blueprint editor share ReactFlow, one automatic layout engine,
and one node style. T3 Code's `components/ui` primitives
(button, badge, table, dialog, menu, select, sidebar) are the starting point
for Heddle's own, so that both products look and behave the same.

Each screen and each reusable part in this document is one React component,
with the same name as the design canvas uses:

- `AppShell`: header, sidebar, and the content region. The canvas keeps it in
  `Main`.
- `OverviewContent`, `BoardContent`, `EpicsContent`, `RunsContent`,
  `PortfolioContent`, `EnvironmentsContent`: the content of each sidebar
  screen. `RunsContent`
  holds both the list and the run page.
- `TaskCard`: one card on the Board, used wherever a task shows as a card.
- `TaskNode`: a ReactFlow custom node for a task in a graph.

Components read colors from the token names in this document, set as CSS
custom properties on the root element, so that a theme change is one class
change.

## Do and don't

- Do reuse T3 Code's token names in code, so that a T3 Code theme (including
  an imported VS Code theme) can apply to Heddle later.
- Do keep one primary button per view.
- Do show state with a dot or badge and a text label.
- Don't add brand color to surfaces, gradients, or colored left borders on
  cards.
- Don't use emoji as icons.
- Don't use shadows to separate surfaces that a border can separate.
