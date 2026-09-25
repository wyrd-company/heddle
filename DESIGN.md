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
    link: "#1b4ed8"
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
    link: "#7ea2ff"
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
- **Code.** In code editors, paths and names use `link` color, strings use
  `success-foreground`, `true`, `false`, and `null` use
  `warning-foreground`, and operators, punctuation, and comments use
  `muted-foreground`.
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
- **Configure**: Blueprints, GitHub Projects, Environments.

Settings is at the bottom of the sidebar; Task fields is a Settings section.
Overview is the default screen.

These are not in the sidebar. The operator opens them from another screen, and
the header breadcrumb shows the path:

- Task: from a Board card, an Epics node, or a Runs row.
- Run detail: from Runs.
- Blueprint editor: from Blueprints.
- A Project's configuration and Apply: from GitHub Projects.
- Task fields: from Settings, with quick links on Blueprints and GitHub
  Projects.
- Portfolio item edit: from Portfolio.

Heddle uses T3 Code's words. A T3 Code server is an **environment**, and a T3
Code project is a workspace folder, so the GitHub screen is "GitHub Projects",
never "Projects".

### Overview

The shell reference screen. From top to bottom:

- Title row: "Overview" and a one-line description. No primary action.
- Four stat tiles: active runs, items that need attention, the budget source
  account closest to its limit (with a meter and the account count), and
  environments connected.
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

**Budget sources.** A budget source is an account. Heddle tracks usage per
account, and one Heddle can draw on several accounts of the same kind. An
account is known by the environments whose harness is signed in to it. Usage
draws from one or more of them:

- An API budget: dollars over a calendar month, with a reset day.
- A subscription: usage windows set by the provider: a rolling 5-hour window,
  a weekly window, and weekly caps on single models (for example, one model
  may use at most 50% of the weekly window). A provider can grant a reset
  that the operator may use before it expires. Heddle shows granted resets
  and their expiry; it does not use them.

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
- Budget source cards, one per account: name, kind, one meter per window
  with its value and estimated reset, a granted-reset badge with its expiry,
  and a note when an early reset was detected.
- Columns: Name, Budget (share and API amount), Current usage, Lifetime
  cost, Active tasks, Completed tasks, and an Edit icon button. A total row
  closes the table.
- Current usage shows one meter: the account and window closest to the
  item's share of it, named ("Subscription A · weekly"). A "+N" after it
  lists the other accounts and their percentages on hover and to screen
  readers.
- A usage meter at 85% or more of the item's share is warning and shows
  "Near limit".
- An item with sub-budgets has a chevron that shows them as indented rows on
  the `lane` surface, with the same columns.
- "Other" is always the last item. It takes every task with no portfolio
  item. It has a share like any item, but it has no Edit button and cannot
  be renamed or archived.
- Under the table, "Show archived (N)" lists archived items with their
  archive date, lifetime cost, completed tasks, and "Restore". A restored
  item comes back with a 0% share.

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

The footer has "Archive item" on the left (error text, outline). Items are
archived, never deleted: an archived item keeps its history, and its share
moves to "Other" so the shares still add up to 100%.

"Add item" opens the same dialog with only a name. A new item starts at 0%.

### Runs

A list of blueprint runs. A run opens as its own page under Runs; the header
breadcrumb shows "Runs / #ref run", and "Runs" in it returns to the list.

#### Runs list

- Title row: "Runs" and a one-line description. No primary action.
- Filters in one row: an Active / Completed segmented control, then
  Portfolio item, Blueprint, Environment, and Account selects. The run count
  is right-aligned.
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
  environment, account, and start time. On the right: a Timeline / Sequence segmented
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

### Blueprints

The processes Heddle runs, from the process repository.

#### Blueprints list

- Title row: "Blueprints", a one-line description, and "Add blueprint"
  (primary). Add blueprint opens a 440px dialog with a name (lowercase
  letters, digits, and hyphens) and "Start from", a published blueprint to
  copy. "Create draft" opens the editor on the new draft.
- Columns: Name (mono, with a one-line description), Version (short SHA in
  mono and date), Active runs, and an Edit button. A blueprint with a local
  draft shows a "Draft" badge.
- Edit, or the name, opens the editor. The breadcrumb shows
  "Blueprints / name".

#### Blueprint editor

The editor works on a local draft. Publish commits the draft and pushes it
to the process repository.

- Header (56px): the blueprint name in mono, the version the draft is based
  on, a "Draft · N changes" badge, tabs (Graph, Source, Input schema,
  Output schema), then "Discard draft" (ghost), "Auto layout" (outline, Graph tab
  only), and "Publish" (primary).
- "Discard draft" asks first, in a 400px alert dialog that names the number
  of changes and the published version that stays. The confirm button is
  solid error.
- Left: the node-type palette (208px), with a filter field and the node
  types in groups. Each entry is the type name in mono with its icon; its
  description is the tooltip. A type is dragged onto the canvas.
- Center: the ReactFlow canvas on the dotted grid. The layout is automatic
  (Dagre or ELK), top to bottom. Edges carry the result name as a mono pill.
  Edges into and out of the selected node are primary. A node changed in
  the draft has a warning dot. Zoom controls at the bottom left.
- Right: `NodeSettings` for the selected node (320px): node id, the fields
  for its type, and its results with the node each one leads to ("not
  connected", in warning text, when a result has no edge).
- Bottom of the canvas: the Problems strip (below).

`BlueprintNode` is 168×56: an icon chip, the node id in mono (weight 600),
and the type name. Selection is a 2px primary border with a ring, as for
`TaskNode`.

Node types, in palette groups:

| Group | Types |
| --- | --- |
| Decide | `rules` |
| Flow | `start-sub-run` (blocking or not), `emit-event`, `wait`, `finalize` |
| Thread | `thread-create`, `turn-start`, `stop-thread-session`, `thread-archive` |
| Card and issue | `update-card-status`, `release-card`, `card-status-revert`, `issue-reopen` |
| People | `notify` (up to three action buttons), `escalate` |

`thread-create` stores the new thread's id at a run-context path.
`turn-start` reads a thread id from the run context, so several turns can
share a thread. Its edit component also has the prompt template and the
handoff schema.

#### Source

The Source tab shows the blueprint YAML the draft generates, read only, full
width, in the code editor with line numbers. Lines that differ from the
published version have a 3px warning bar in the gutter and a faint warning
background. A toolbar (48px) shows the file path, "Generated from the graph
· read only", the legend for changed lines, and "Copy".

#### Node settings

Each node type declares its results; edges pick from them.

| Type | Settings | Results |
| --- | --- | --- |
| `rules` | decision model path; "Open rules editor" | the model's output values |
| `start-sub-run` | blueprint, Blocking / Non-blocking, input mapping | `completed`, `failed`; `started` when non-blocking |
| `emit-event` | event name, payload | `emitted` |
| `wait` | event name, JSONata match, optional timeout | `received`, `timeout` |
| `finalize` | output mapping to the output schema | none; ends the run |
| `thread-create` | environment, run-context path for the thread id | `created` |
| `turn-start` | thread id path, prompt template, handoff schema | `handoff`, `idle` |
| `stop-thread-session` | thread id path | `done` |
| `thread-archive` | thread id path | `done` |
| `update-card-status` | lifecycle state | `done` |
| `release-card` | none | `done` |
| `card-status-revert` | none | `done` |
| `issue-reopen` | optional comment template | `done` |
| `notify` | message template, up to three actions (label → result) | one per action |
| `escalate` | brief template | `resolved`, `unresolved` |

A timeout exists only where the author sets one.

Mappings (input, output, actions) are rows of two mono inputs joined by an
arrow, with an "Add" button under them.

Values that pass data in or build it (sub-run inputs, `finalize` outputs, the
`emit-event` payload, the `wait` match) are JSONata expressions evaluated
against the run context. Their labels say "JSONata", and each field has an
expand button at its right edge.

#### Expression editor

The expand button opens a 920px dialog titled with the node, field, and key.
On the left, the expression in a code editor. On the right, the result of
the expression against a chosen source: the context of a recent run of this
blueprint, or a sample built from the input schema. Under the editor, the
parse state ("Valid JSONata" or the error and its position); under the
result, whether it matches the schema the field feeds. "Apply" writes the
expression back to the field.

#### Problems

The editor validates the draft as it changes. A strip under the canvas
shows the count of errors (error color) and warnings (warning color) and
lists each problem with its node id; a problem opens its node. A node with a
problem has a 16px "!" badge on its top-right corner, error or warning
colored. The strip collapses to its 36px header.

- Error: the blueprint cannot run as drawn, such as a rules output with no
  edge. Publish is disabled until every error is fixed.
- Warning: a declared result with no edge. Warnings do not block Publish.

#### Input and output schemas

A blueprint has an input schema (what a run starts with) and an output
schema (what a run returns; `finalize` maps into it). Both are JSON Schema,
stored as YAML in the process repository. Each has its own editor tab.

- A toolbar (48px): a Visual / YAML switch, the count, and "Add property"
  (outline, Visual only). The add button stays in the toolbar so a long
  table does not hide it.
- Visual: the property table: Property (mono, indented for nesting, with a
  chevron on object rows), Type (string, number, integer, boolean, object,
  array, enum), Required (checkbox), Description, and remove.
- YAML: the whole file, full width, in a code editor. Both views edit the
  same document; comments written in the YAML are kept when the table
  changes it.

#### Rules editor

A `rules` node evaluates a JDM decision model from the process repository.
Its edit component summarizes the model (rule count, hit policy, inputs) and
has "Open rules editor". That opens the JDM editor in a 920px dialog, themed
with Heddle's tokens: inputs and outputs as mono column headers, output
columns on the `accent` surface, one row per rule, "Add rule", "Add input",
"Add output", and "Apply to draft".

#### Publish

A 480px dialog: the changed files with their git status letter (A success,
M warning) and path in mono, a commit message, and the target repository and
branch. "Commit and push" commits and pushes. New runs use the new version;
runs already started keep theirs.

### GitHub Projects

To use Heddle, you give it control of each bound Project's configuration.
The task fields decide what that configuration is; Heddle creates it and
keeps it in step.

#### Projects list

- Title row: "GitHub Projects", a one-line description, "Task fields"
  (ghost, a quick link), and "Bind a Project" (primary).
- Columns: Project (`org/name` in mono, linking to GitHub), Active cards,
  Completed cards, Environment (the T3 Code server for its threads, or "Any
  connected"), Configuration, and an action.
- Configuration is a badge: "In sync" (success), "Drift · N" (warning; the
  configuration was changed outside Heddle), or "Not applied" (info; bound
  but never applied). The action is "View" when in sync and "Review
  changes" otherwise.

#### Bind a Project

A 480px dialog: Project, Environment, and a warning note that Heddle takes
control of the Project's fields and status options and of the labels, issue
types, issue fields, and milestones the task fields use. "Bind and review
changes" is disabled until "I understand" is checked. It opens the Project's
page with its first Apply.

#### A Project's page

- Header: "All Projects" back link, the Project name in mono with a GitHub
  link and its Configuration badge; a meta line with the environment, the
  task fields version, and when it was last applied. On the right: "Task
  fields" (ghost) and "Apply N changes" (primary; "Nothing to apply" and
  disabled when in sync).
- Apply on this page is for Projects with drift or never applied. A Project
  in sync takes task field changes automatically when they are published.
- One card, "What Apply will change", with a switch "Also remove what the
  task fields do not define" (off by default). Groups, one per storage kind:
  Project fields, Labels, Org issue types, Org issue fields, Milestones,
  Front matter. Each group names where it applies and sums its changes.
- A change row: a 18px mark (`+` create in success, `~` change in warning,
  `−` remove in error), the target in mono, and what happens. A change that
  undoes drift has a "Drift" badge. With the switch off, a removal row is
  dimmed with a "Kept" badge and does not count.
- Front matter has nothing to apply. When issues hold front matter that does
  not match the task fields, the group says how many, with a link to them.
- Lifecycle states are Heddle's: Apply sets the Project's Status options to
  them.

### Settings

Settings has tabs under its title: Task fields, Accounts and budget sources,
and General.

#### Task fields

The fields every task carries and where each one lives on GitHub. The schema
is per process repository, JSON Schema stored as YAML, with the same draft,
discard, and publish path as a blueprint.

Publishing scans the bound Projects first. The Publish dialog (600px when
there are Projects) lists each one with its counts of creates, changes, and
removes, and what happens after Publish: a Project that is in sync updates
automatically; a Project with drift, or never applied, waits for review on
its own page. Removes follow each Project's removal switch. The section
header also says how many Projects the draft changes, with "Review impact".

- Section header: "Task fields", a "Draft · N changes" badge, a one-line
  description, "Discard draft" (ghost), and "Publish" (primary). A line with
  the published version, its date, the file path, and the draft's impact on
  bound Projects.
- The schema editor, in storage mode: rows are called fields, a "Stored as"
  column follows Type, and Visual has a field panel (360px) on the right for
  the selected field. "Add field" adds a front-matter string field and
  selects it.
- Fields that Heddle sets (`lifecycleState`, `blueprint`, `portfolioItem`)
  have a lock badge "Heddle": their name, Required box, and storage cannot
  change, and they cannot be removed.

Where a field can live, and what it can hold:

| Stored as | Types | Scope |
| --- | --- | --- |
| Project field | string, number, integer, enum, date | each bound Project |
| Org issue field | string, number, integer, enum, date | the whole org |
| Org issue type | enum (one issue type per value) | the whole org |
| Label | enum (one label per value, with a prefix), boolean | each repository |
| Milestone | string, enum (the title is the value) | each repository |
| Front matter | any type, including objects and lists | each issue |

Front matter is a hidden YAML block in an HTML comment at the top of the
issue description. Nested properties live inside their parent, so a nested
row shows "in parent" in the Stored as column.

- Selecting a row shows it in the field panel: "Stored as", whether that storage
  can hold the type, the kind's settings (project or issue field name, label
  prefix, front matter key), what exists on GitHub for it, and its scope.
- A field whose type its storage cannot hold is an error: a red "!" on the
  row, red borders on Type and Stored as, and a Problems box under the table.
  Publish is disabled while there are errors.
- The YAML records each field's storage under `x-heddle-storage` (kind, plus
  field, prefix, or key).

#### Accounts and budget sources

Each account is a budget source (see Portfolio). The section lists them and
holds what the operator sets; Heddle learns the rest from reported usage.

- Section header: "Accounts and budget sources", a one-line description, and
  "Add account" (primary).
- Columns: Account (name, provider, and the environments that use it, in
  mono), Kind (API
  or Subscription, with the plan), Budget (an API account's monthly amount
  and reset day; a subscription's windows), Current use (the window closest
  to its limit, named, with a meter; a granted-reset badge when there is
  one), Last report (a success dot when recent, an idle dot when not), and
  an Edit icon button.
- A Pricing card: how subscription cost is estimated, when the price table
  was updated, how many models it has, a warning count of models in use
  with no price, and "Refresh".

Add account and Edit account are one 520px dialog:

- Kind: API budget or Subscription (fixed once the account exists).
- Name and Provider.
- Used by: the environments whose harness for that provider is signed in to
  this account, as checkboxes. T3 Code does not know accounts; the harness
  on each environment is signed in to one. Heddle counts an environment's
  usage for that provider against the account that lists it. An environment
  and provider pair belongs to one account, so a pair another account uses
  is disabled with "Used by" and that account's name.
- API budget: Monthly budget and "Resets on".
- Subscription: Plan, the usage windows and model caps as detected (read
  only), and granted resets with their expiry (shown, never used). A new
  subscription says its windows appear after the first usage report.
- Edit has "Archive account" at the bottom left (error text, outline).
  Accounts are archived, never deleted, so past usage keeps its source.

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
variants, and lucide-react for icons. Heddle adds dnd-kit for drag and drop
(pointer, touch, and keyboard), ReactFlow (`@xyflow/react`) for graphs, and
CodeMirror 6 for code: YAML with `@codemirror/lang-yaml`, and JSONata
expressions. The Epics graph and the blueprint editor share ReactFlow, one
automatic layout engine, and one node style. T3 Code's `components/ui` primitives
(button, badge, table, dialog, menu, select, sidebar) are the starting point
for Heddle's own, so that both products look and behave the same.

Each screen and each reusable part in this document is one React component,
with the same name as the design canvas uses:

- `AppShell`: header, sidebar, and the content region. The canvas keeps it in
  `Main`.
- `OverviewContent`, `BoardContent`, `EpicsContent`, `RunsContent`,
  `PortfolioContent`, `BlueprintsContent`, `ProjectsContent`,
  `EnvironmentsContent`, `SettingsContent`: the content of each sidebar
  screen. `TaskFieldsContent` is a Settings section.
  `BlueprintsContent` holds both the list and the editor, and `RunsContent`
  holds both the list and the run page.
- `TaskCard`: one card on the Board, used wherever a task shows as a card.
- `TaskNode`: a ReactFlow custom node for a task in a graph.
- `BlueprintNode`: a ReactFlow custom node for a blueprint node.
- `AccountsContent`: the Accounts and budget sources section of Settings.
- `NodeSettings`: the edit component for a blueprint node, one set of fields
  per node type.
- `SchemaEditor`: a Visual / YAML editor for a JSON Schema, used for
  blueprint input and output schemas, and in storage mode (Stored as column,
  field panel, Problems) for Task fields.
- `PublishDialog` and `DiscardDialog`: the draft publish and discard dialogs,
  used by the blueprint editor and Task fields.
- The rules editor is `@gorules/jdm-editor`, themed with Heddle's tokens.
- YAML is read and written with the `yaml` package's document model, so
  that comments survive edits from the schema table.

Components read colors from the token names in this document, set as CSS
custom properties on the root element, so that a theme change is one class
change.

## Known pitfalls

Heddle does not guard against these; the operator decides how to handle them.

- Org issue fields and org issue types need org admin rights. Without them,
  Apply cannot create those kinds of storage. How Heddle gets the rights
  (asking each time, a separate GitHub App, or a personal access token) is
  the operator's choice.
- Org issue fields and org issue types are shared by the whole org. Two
  Heddle installs, or two process repositories, that store different fields
  under the same name will overwrite each other.
- Front matter lives in the issue description. A person or an agent that
  edits the description can break it. Heddle reports issues whose front
  matter does not match the task fields.
- Changes made by hand to a bound Project's configuration show as drift, and
  Apply undoes them.
- Heddle knows which account an environment's harness uses only from
  Settings. If someone signs a harness in to a different account, Heddle
  counts that usage against the old account until "Used by" changes.

## Do and don't

- Do reuse T3 Code's token names in code, so that a T3 Code theme (including
  an imported VS Code theme) can apply to Heddle later.
- Do keep one primary button per view.
- Do show state with a dot or badge and a text label.
- Don't add brand color to surfaces, gradients, or colored left borders on
  cards.
- Don't use emoji as icons.
- Don't use shadows to separate surfaces that a border can separate.
