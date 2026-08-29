// ---
// relationships:
//   implements: heddle
// ---

export const consolePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:,">
    <title>Heddle Console</title>
    <link rel="stylesheet" href="/assets/console.css">
    <link rel="stylesheet" href="/assets/lifecycle.css">
  </head>
  <body>
    <header class="masthead">
      <a class="wordmark" href="/?scope=all" aria-label="Heddle console home">
        <span class="wordmark-mark" aria-hidden="true">H</span>
        <span><strong>HEDDLE</strong><small>WORKFLOW CONSOLE</small></span>
      </a>
      <div class="masthead-state">
        <span class="live-mark" aria-hidden="true"></span>
        <span>LIVE BOARD</span>
        <button class="attention-toggle" id="attention-toggle" type="button" aria-controls="attention-overlay" aria-expanded="false">
          <span>ATTENTION</span>
          <span class="attention-count" id="attention-count" role="status" aria-label="Attention items">0</span>
        </button>
      </div>
    </header>
    <dialog class="attention-overlay" id="attention-overlay" aria-labelledby="attention-title">
      <div class="attention-sheet">
        <header class="attention-header">
          <div>
            <p class="eyebrow">OPERATOR QUEUE</p>
            <h2 id="attention-title">Attention required</h2>
          </div>
          <button class="attention-close" id="attention-close" type="button" aria-label="Close attention queue">CLOSE ×</button>
        </header>
        <p class="attention-status" id="attention-status" aria-live="polite"></p>
        <div class="attention-list" id="attention-list"></div>
      </div>
    </dialog>
    <section class="control-rail" aria-label="Board controls">
      <div>
        <p class="eyebrow" id="view-eyebrow">KANBAN PROJECTION</p>
        <h1 id="view-title">Delivery floor</h1>
      </div>
      <div class="view-controls">
        <nav class="view-tabs" aria-label="Console views">
          <a id="board-view-link" href="/?scope=all">BOARD</a>
          <a id="dependencies-view-link" href="/?view=dependencies&amp;scope=all">DEPENDENCIES</a>
        </nav>
        <label class="scope-control" for="scope">
          <span>SCOPE</span>
          <select id="scope" name="scope">
            <option value="all">All work</option>
          </select>
        </label>
      </div>
    </section>
    <main>
      <p id="console-status" class="console-status" aria-live="polite">Loading board…</p>
      <div id="board" class="board" role="region" aria-label="Kanban board" tabindex="0"></div>
      <section id="dependency-graph" class="dependency-graph" aria-labelledby="dependency-graph-title" hidden>
        <header class="graph-header">
          <div>
            <p class="eyebrow">READINESS PATHS</p>
            <h2 id="dependency-graph-title">Task dependencies</h2>
          </div>
          <ul class="graph-legend" aria-label="Node status legend">
            <li data-treatment="done"><span aria-hidden="true"></span>Done</li>
            <li data-treatment="running"><span aria-hidden="true"></span>Running</li>
            <li data-treatment="attention"><span aria-hidden="true"></span>Attention</li>
            <li data-treatment="blocked"><span aria-hidden="true"></span>Blocked</li>
          </ul>
        </header>
        <div id="graph-viewport" class="graph-viewport" role="region" aria-label="Task dependency graph" tabindex="0">
          <div id="graph-canvas" class="graph-canvas"></div>
        </div>
      </section>
      <section id="lifecycle-view" class="lifecycle-view" aria-labelledby="lifecycle-view-title" hidden>
        <header class="lifecycle-header">
          <div>
            <p class="eyebrow">TASK LIFECYCLE</p>
            <h2 id="lifecycle-view-title">Lifecycle canvas</h2>
          </div>
          <p id="lifecycle-task" class="lifecycle-task"></p>
        </header>
        <div id="lifecycle-canvas-root"></div>
      </section>
    </main>
    <script type="module" src="/assets/lifecycle.js"></script>
    <script type="module" src="/assets/console.js"></script>
  </body>
</html>`;

export const consoleStyles = `:root {
  color-scheme: light;
  --ink: #191a17;
  --paper: #f2efe6;
  --paper-raised: #fffdf7;
  --rule: #b8b3a5;
  --rule-dark: #77746b;
  --signal: #b43321;
  --signal-on-dark: #f08a78;
  --signal-focus: #df5a3c;
  --active: #25766e;
  --deferred: #74540a;
  --muted: #5f605a;
  --shadow: 3px 3px 0 rgba(25, 26, 23, 0.16);
  font-family: "Azeret Mono", "IBM Plex Mono", ui-monospace, monospace;
  background: var(--paper);
  color: var(--ink);
}

* { box-sizing: border-box; }

body {
  min-width: 320px;
  margin: 0;
  background-color: var(--paper);
}

button, input, select { font: inherit; }

.masthead {
  min-height: 68px;
  padding: 12px clamp(18px, 3vw, 42px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  color: var(--paper-raised);
  background: var(--ink);
  border-bottom: 5px solid var(--signal);
}

.wordmark {
  color: inherit;
  display: flex;
  align-items: center;
  gap: 12px;
  text-decoration: none;
  letter-spacing: 0.13em;
}

.wordmark-mark {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 2px solid currentColor;
  font-size: 22px;
  font-weight: 900;
}

.wordmark strong, .wordmark small { display: block; }
.wordmark small { margin-top: 3px; color: #bbb9b1; font-size: 9px; }

.masthead-state {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #d5d3cc;
  font-size: 11px;
  letter-spacing: 0.08em;
}

.attention-toggle {
  padding: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.09em;
}

.attention-toggle:focus-visible, .attention-close:focus-visible, .attention-action:focus-visible, .attention-option input:focus-visible {
  outline: 2px solid var(--signal-focus);
  outline-offset: 3px;
}

.live-mark {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #62c99b;
  box-shadow: 0 0 0 3px rgba(98, 201, 155, 0.17);
}

.attention-count {
  min-width: 25px;
  padding: 3px 7px;
  color: var(--paper-raised);
  background: var(--signal);
  text-align: center;
  font-weight: 800;
}

.attention-overlay {
  z-index: 2147483647;
  width: min(560px, calc(100vw - 24px));
  height: 100dvh;
  max-height: none;
  margin: 0 0 0 auto;
  padding: 0;
  color: var(--ink);
  background: var(--paper);
  border: 0;
  border-left: 5px solid var(--signal);
  box-shadow: -12px 0 35px rgba(25, 26, 23, 0.24);
  overflow: hidden;
}

.attention-overlay::backdrop { background: rgba(25, 26, 23, 0.58); }
.attention-sheet { height: 100%; min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
.attention-header { padding: 22px 22px 18px; display: flex; align-items: start; justify-content: space-between; gap: 24px; color: var(--paper-raised); background: var(--ink); border-bottom: 4px solid var(--signal); }
.attention-header .eyebrow { color: var(--signal-on-dark); }
.attention-header h2 { margin: 0; font-family: Georgia, serif; font-size: 29px; font-weight: 500; }
.attention-close { padding: 7px 0; color: #d5d3cc; background: transparent; border: 0; cursor: pointer; font-size: 10px; font-weight: 800; letter-spacing: 0.09em; }
.attention-status { min-height: 38px; margin: 0; padding: 11px 22px; color: var(--muted); border-bottom: 1px solid var(--rule); font-size: 10px; }
.attention-status[data-error="true"] { color: var(--signal); font-weight: 800; }
.attention-list { min-height: 0; padding: 14px; display: grid; align-content: start; gap: 12px; overflow-y: auto; }
.attention-empty { margin: 20px 8px; color: var(--muted); font-family: Georgia, serif; font-size: 21px; }

.attention-entry { padding: 15px; background: var(--paper-raised); border: 1px solid var(--rule-dark); box-shadow: var(--shadow); }
.attention-entry:focus { outline: 3px solid var(--signal-focus); outline-offset: 2px; }
.attention-entry[data-focused="true"] { border-color: var(--signal); box-shadow: 5px 5px 0 rgba(180, 51, 33, 0.22); }
.attention-entry-meta { margin: 0 0 9px; display: flex; justify-content: space-between; gap: 12px; color: var(--signal); font-size: 9px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
.attention-entry h3 { margin: 0; font-family: Georgia, serif; font-size: 19px; font-weight: 500; line-height: 1.25; }
.attention-entry-message { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.attention-actions { margin-top: 14px; padding-top: 13px; display: grid; gap: 10px; border-top: 1px dotted var(--rule-dark); }
.attention-question { min-width: 0; margin: 0; padding: 9px; display: grid; gap: 8px; border: 1px solid var(--rule); }
.attention-question legend { padding: 0 5px; font-size: 10px; font-weight: 800; }
.attention-option { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start; color: var(--muted); font-size: 10px; }
.attention-option input { margin-top: 2px; accent-color: var(--signal); }
.attention-option strong, .attention-option small { display: block; }
.attention-option strong { color: var(--ink); font-size: 10px; }
.attention-option small { margin-top: 2px; line-height: 1.35; }
.attention-action { width: 100%; padding: 9px 11px; color: var(--paper-raised); background: var(--ink); border: 1px solid var(--ink); cursor: pointer; text-align: left; font-size: 10px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }
.attention-action:hover { background: var(--signal); border-color: var(--signal); }
.attention-action:disabled { cursor: wait; opacity: 0.55; }
.attention-entry[data-actionless="true"] .attention-actions { color: var(--muted); font-size: 10px; }

.control-rail {
  padding: 26px clamp(18px, 3vw, 42px) 20px;
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  border-bottom: 1px solid var(--rule-dark);
}

.view-controls { display: grid; gap: 10px; justify-items: end; }
.view-tabs { display: flex; gap: 3px; }
.view-tabs a {
  padding: 5px 8px;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-decoration: none;
}
.view-tabs a[aria-current="page"] { color: var(--ink); border-color: var(--signal); }
.view-tabs a:focus-visible, .graph-node:focus-visible { outline: 2px solid var(--signal-focus); outline-offset: 3px; }

.eyebrow, .scope-control span {
  margin: 0 0 7px;
  color: var(--signal);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}

h1 { margin: 0; font-family: Georgia, serif; font-size: clamp(30px, 4vw, 48px); font-weight: 500; }

.scope-control { display: grid; min-width: min(320px, 48vw); }

select {
  width: 100%;
  padding: 10px 34px 10px 12px;
  color: var(--ink);
  background: var(--paper-raised);
  border: 1px solid var(--rule-dark);
  border-radius: 0;
}

select:focus-visible { outline: 2px solid var(--signal-focus); outline-offset: 3px; }

main { padding: 16px clamp(18px, 3vw, 42px) 42px; }

.console-status { min-height: 18px; margin: 0 0 10px; color: var(--muted); font-size: 11px; }
.console-status[data-error="true"] { color: #a92e1c; font-weight: 800; }

.board {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(260px, 1fr);
  gap: 10px;
  overflow-x: auto;
  padding: 0 0 16px;
  scroll-snap-type: x proximity;
}

.board:focus-visible { outline: 2px solid var(--signal-focus); outline-offset: 2px; }

.column {
  min-height: 430px;
  background: rgba(255, 253, 247, 0.5);
  border: 1px solid var(--rule);
  scroll-snap-align: start;
}

.column-header {
  padding: 11px 13px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 3px solid var(--ink);
}

.column-header h2 { margin: 0; font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; }
.column-count { color: var(--muted); font-size: 11px; }
.card-stack { display: grid; gap: 10px; padding: 10px; }

.task-card {
  padding: 13px 13px 13px 10px;
  background: var(--paper-raised);
  border: 1px solid var(--rule-dark);
  border-left-width: 4px;
  box-shadow: var(--shadow);
}

.task-card[data-status="in-progress"] { border-left-color: var(--active); }
.task-card[data-blocked="true"] { border-left-color: var(--signal); }
.card-id { margin: 0 0 8px; color: var(--muted); font-size: 9px; font-weight: 800; letter-spacing: 0.12em; }
.card-title { margin: 0; font-family: Georgia, serif; font-size: 17px; line-height: 1.22; }

.card-meta {
  margin: 13px 0 0;
  padding: 9px 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  border-top: 1px dotted var(--rule);
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
}

.stage-readout {
  margin: 12px 0 0;
  padding: 9px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 7px;
  color: #f3f3ed;
  background: var(--active);
  font-size: 10px;
}

.stage-readout strong { overflow-wrap: anywhere; letter-spacing: 0.05em; text-transform: uppercase; }

.deferral-readout {
  margin: 12px 0 0;
  padding: 9px;
  display: grid;
  gap: 4px;
  color: var(--paper-raised);
  background: var(--deferred);
  font-size: 10px;
}

.deferral-readout strong { letter-spacing: 0.08em; }

.epic-lever {
  width: 100%;
  margin-top: 12px;
  padding: 8px 10px;
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--ink);
  cursor: pointer;
  text-align: left;
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
}

.epic-lever:hover, .epic-lever:focus-visible { color: var(--paper-raised); background: var(--ink); outline: 2px solid var(--signal-focus); outline-offset: 2px; }
.empty-column { margin: 18px 13px; color: var(--muted); font-size: 10px; }

[hidden] { display: none !important; }

.dependency-graph {
  min-width: 0;
  background: rgba(255, 253, 247, 0.55);
  border: 1px solid var(--rule-dark);
}

.graph-header {
  min-height: 76px;
  padding: 13px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  border-bottom: 3px solid var(--ink);
}

.graph-header h2, .lifecycle-view h2 { margin: 0; font-family: Georgia, serif; font-size: 24px; font-weight: 500; }
.graph-header .eyebrow { margin-bottom: 4px; }
.graph-legend { margin: 0; padding: 0; display: flex; flex-wrap: wrap; justify-content: end; gap: 8px 14px; list-style: none; }
.graph-legend li { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 9px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.graph-legend span { width: 11px; height: 11px; background: var(--paper-raised); border: 2px solid var(--rule-dark); }
.graph-legend [data-treatment="done"] span { background: #356b51; border-color: #356b51; }
.graph-legend [data-treatment="running"] span { background: var(--active); border-color: var(--active); }
.graph-legend [data-treatment="attention"] span { background: var(--signal); border-color: var(--signal); }
.graph-legend [data-treatment="blocked"] span { background: #8b6511; border-color: #5f4305; }

.graph-viewport {
  min-height: 480px;
  overflow: auto;
  background-image: radial-gradient(circle, rgba(25, 26, 23, 0.16) 0.8px, transparent 0.9px);
  background-size: 18px 18px;
}
.graph-viewport:focus-visible { outline: 2px solid var(--signal-focus); outline-offset: -4px; }
.graph-canvas { position: relative; min-height: 480px; }
.graph-edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
.graph-edge { fill: none; stroke: var(--rule-dark); stroke-width: 2; marker-end: url(#dependency-arrow); }
.graph-edge[data-trace="true"] { stroke: var(--signal); stroke-width: 4; stroke-dasharray: 8 5; }

.graph-node {
  position: absolute;
  width: 220px;
  height: 126px;
  box-sizing: border-box;
  overflow: hidden;
  padding: 12px 13px 11px;
  display: flex;
  flex-direction: column;
  color: var(--ink);
  background: var(--paper-raised);
  border: 2px solid var(--rule-dark);
  border-left-width: 6px;
  box-shadow: var(--shadow);
  text-decoration: none;
}
.graph-node:hover { transform: translate(-2px, -2px); box-shadow: 5px 5px 0 rgba(25, 26, 23, 0.19); }
.graph-node[data-treatment="done"] { border-color: #356b51; }
.graph-node[data-treatment="running"] { border-color: var(--active); }
.graph-node[data-treatment="attention"] { border-color: var(--signal); box-shadow: 4px 4px 0 rgba(180, 51, 33, 0.23); }
.graph-node[data-treatment="blocked"] { border-color: #5f4305; background: #f6f0df; }
.graph-node-id { display: block; margin-bottom: 7px; color: var(--muted); font-size: 9px; font-weight: 800; letter-spacing: 0.11em; }
.graph-node-title { display: -webkit-box; font-family: Georgia, serif; font-size: 16px; line-height: 1.18; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; overflow-wrap: anywhere; }
.graph-node-state { display: block; margin-top: auto; padding-top: 10px; font-size: 9px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
.graph-node[data-treatment="attention"] .graph-node-state { color: var(--signal); }
.graph-node[data-treatment="blocked"] .graph-node-state { color: #684a08; }

.lifecycle-view { min-width: 0; min-height: 360px; background: var(--paper-raised); border: 1px solid var(--rule-dark); }
.lifecycle-header { min-height: 76px; padding: 13px 16px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.lifecycle-header .eyebrow { margin-bottom: 4px; }
.lifecycle-task { margin: 0; color: var(--muted); font-size: 10px; text-align: right; }

@media (max-width: 680px) {
  .masthead-state > span:not(.live-mark), .attention-toggle > span:first-child { display: none; }
  .attention-overlay { width: 100vw; max-width: none; border-left: 0; }
  .control-rail { align-items: stretch; flex-direction: column; }
  .view-controls { justify-items: stretch; }
  .view-tabs { justify-content: space-between; }
  .scope-control { min-width: 0; }
  .graph-header { align-items: flex-start; flex-direction: column; }
  .graph-legend { justify-content: start; }
}

@media (prefers-reduced-motion: no-preference) {
  .task-card { animation: settle 220ms ease-out both; }
  @keyframes settle { from { opacity: 0; transform: translateY(5px); } }
}`;

export const consoleClient = `const boardElement = document.querySelector("#board");
const scopeElement = document.querySelector("#scope");
const statusElement = document.querySelector("#console-status");
const attentionElement = document.querySelector("#attention-count");
const attentionToggleElement = document.querySelector("#attention-toggle");
const attentionOverlayElement = document.querySelector("#attention-overlay");
const attentionCloseElement = document.querySelector("#attention-close");
const attentionStatusElement = document.querySelector("#attention-status");
const attentionListElement = document.querySelector("#attention-list");
const graphElement = document.querySelector("#dependency-graph");
const graphViewportElement = document.querySelector("#graph-viewport");
const graphCanvasElement = document.querySelector("#graph-canvas");
const lifecycleElement = document.querySelector("#lifecycle-view");
const lifecycleTaskElement = document.querySelector("#lifecycle-task");
const viewEyebrowElement = document.querySelector("#view-eyebrow");
const viewTitleElement = document.querySelector("#view-title");
const boardViewLink = document.querySelector("#board-view-link");
const dependenciesViewLink = document.querySelector("#dependencies-view-link");
let loadGeneration = 0;
let lifecyclePollTimer;

const scopeFromUrl = () => new URL(window.location.href).searchParams.get("scope") || "all";
const attentionFromUrl = () => new URL(window.location.href).searchParams.get("attention");

const viewFromUrl = () => {
  const view = new URL(window.location.href).searchParams.get("view") || "board";
  if (view !== "board" && view !== "dependencies" && view !== "lifecycle") {
    throw new Error("view must be board, dependencies, or lifecycle");
  }
  return view;
};

const consoleUrl = (view, scope) => {
  const url = new URL("/", window.location.href);
  if (view !== "board") url.searchParams.set("view", view);
  url.searchParams.set("scope", scope);
  const attention = attentionFromUrl();
  if (attention !== null) url.searchParams.set("attention", attention);
  return url.pathname + url.search;
};

const fetchJson = async (url, options) => {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) throw new Error(await response.text());
  return response.status === 204 ? null : response.json();
};

const duration = (milliseconds) => {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h " + (minutes % 60) + "m";
  return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
};

const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
};

const openAttention = () => {
  if (!attentionOverlayElement.open) attentionOverlayElement.showModal();
  attentionToggleElement.setAttribute("aria-expanded", "true");
};

const closeAttention = () => {
  if (attentionOverlayElement.open) attentionOverlayElement.close();
  attentionToggleElement.setAttribute("aria-expanded", "false");
};

attentionToggleElement.addEventListener("click", openAttention);
attentionCloseElement.addEventListener("click", closeAttention);
attentionOverlayElement.addEventListener("close", () => {
  attentionToggleElement.setAttribute("aria-expanded", "false");
});

const enableKeyboardScroll = (element) => {
  element.addEventListener("keydown", (event) => {
    const page = Math.max(80, Math.round(element.clientWidth * 0.7));
    const left =
      event.key === "ArrowLeft"
        ? element.scrollLeft - page
        : event.key === "ArrowRight"
          ? element.scrollLeft + page
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? element.scrollWidth
              : undefined;
    if (left === undefined) return;
    event.preventDefault();
    element.scrollLeft = left;
  });
};

enableKeyboardScroll(boardElement);
enableKeyboardScroll(graphViewportElement);

const selectedAnswers = (questions, controls) => {
  const answers = {};
  for (const question of questions) {
    const selected = controls
      .filter(({ questionId, input }) => questionId === question.id && input.checked)
      .map(({ input }) => input.value);
    if (selected.length === 0) throw new Error("Select an answer for " + question.prompt);
    answers[question.id] = question.multiSelect ? selected : selected[0];
  }
  return answers;
};

const performAttentionAction = async (entry, action, controls, button) => {
  button.disabled = true;
  attentionStatusElement.dataset.error = "false";
  attentionStatusElement.textContent = "Applying " + action.label + "…";
  try {
    const body = { fingerprint: entry.fingerprint };
    if (action.input.kind === "questions") {
      body.answers = selectedAnswers(action.input.questions, controls);
    }
    await fetchJson(
      "/api/attention/" + encodeURIComponent(entry.attentionId) + "/actions/" + encodeURIComponent(action.actionId),
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    await load();
    attentionStatusElement.textContent = "Disposition applied";
  } catch (error) {
    attentionStatusElement.dataset.error = "true";
    attentionStatusElement.textContent = error instanceof Error ? error.message : "Attention action failed";
    button.disabled = false;
  }
};

const createAttentionAction = (entry, action) => {
  const container = document.createElement("section");
  const controls = [];
  if (action.input.kind === "questions") {
    for (const question of action.input.questions) {
      const fieldset = document.createElement("fieldset");
      fieldset.className = "attention-question";
      fieldset.append(
        text(
          "legend",
          question.header
            ? question.header + " — " + question.prompt
            : question.prompt,
        ),
      );
      for (const option of question.options) {
        const label = document.createElement("label");
        label.className = "attention-option";
        const input = document.createElement("input");
        input.type = question.multiSelect ? "checkbox" : "radio";
        input.name = entry.attentionId + ":" + action.actionId + ":" + question.id;
        input.value = option.value;
        const copy = document.createElement("span");
        copy.append(text("strong", option.label));
        if (option.description) copy.append(text("small", option.description));
        label.append(input, copy);
        fieldset.append(label);
        controls.push({ input, questionId: question.id });
      }
      container.append(fieldset);
    }
  }
  const button = text("button", action.label + " →", "attention-action");
  button.type = "button";
  button.addEventListener("click", () => performAttentionAction(entry, action, controls, button));
  container.append(button);
  return container;
};

const renderAttention = (entries) => {
  attentionElement.textContent = String(entries.length);
  attentionListElement.replaceChildren();
  attentionStatusElement.dataset.error = "false";
  attentionStatusElement.textContent = entries.length + (entries.length === 1 ? " item requires" : " items require") + " operator attention";
  const requested = attentionFromUrl();
  if (entries.length === 0) {
    attentionListElement.append(text("p", "No work is waiting for you.", "attention-empty"));
  }
  let focused;
  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = "attention-entry";
    article.dataset.attentionId = entry.attentionId;
    article.dataset.actionless = String(entry.actions.length === 0);
    const meta = document.createElement("p");
    meta.className = "attention-entry-meta";
    meta.append(text("span", entry.kind.replaceAll("-", " ")));
    meta.append(text("span", entry.scope));
    article.append(meta);
    article.append(text("h3", "Attention " + entry.attentionId));
    article.append(text("p", entry.message, "attention-entry-message"));
    const actions = document.createElement("div");
    actions.className = "attention-actions";
    if (entry.actions.length === 0) {
      actions.append(text("p", "No direct disposition is authorized for this state."));
    } else {
      for (const action of entry.actions) actions.append(createAttentionAction(entry, action));
    }
    article.append(actions);
    attentionListElement.append(article);
    if (entry.attentionId === requested) focused = article;
  }
  if (requested !== null) {
    openAttention();
    if (focused) {
      focused.dataset.focused = "true";
      focused.setAttribute("tabindex", "-1");
      focused.focus();
      focused.scrollIntoView({ block: "center" });
    } else {
      attentionStatusElement.dataset.error = "true";
      attentionStatusElement.textContent = "The linked attention item is no longer current";
    }
  }
};

const svg = (tag, attributes) => {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
};

const isEpic = (task) => task.parent === undefined && task.tags.includes("type:epic");

const deferralDetail = (deferral) => {
  switch (deferral.reason) {
    case "work-in-progress-limit":
      return deferral.activeSessions + " / " + deferral.limit + " active sessions";
    case "provider-usage-window": {
      const retryDate = new Date(deferral.retryAt);
      const retryAt = Number.isNaN(retryDate.valueOf())
        ? String(deferral.retryAt)
        : retryDate.toISOString();
      return deferral.provider + " " + deferral.used + " / " + deferral.limit + " until " + retryAt;
    }
    case "subagent-depth-limit":
      return "depth " + deferral.requestedDepth + " / " + deferral.limit;
    case "subagent-fan-out-limit":
      return deferral.activeChildren + " / " + deferral.limit + " active children";
    default:
      return "capacity unavailable";
  }
};

const createCard = (task) => {
  const card = document.createElement("article");
  card.className = "task-card";
  card.dataset.status = task.status;
  card.dataset.blocked = String(task.blocked);
  card.dataset.taskId = String(task.id);
  card.draggable = false;
  card.append(text("p", (isEpic(task) ? "EPIC " : "TASK ") + "#" + task.id, "card-id"));
  card.append(text("h3", task.title, "card-title"));
  const meta = document.createElement("p");
  meta.className = "card-meta";
  meta.append(text("span", task.priority));
  if (task.blocked) meta.append(text("span", "BLOCKED"));
  card.append(meta);

  if (task.stageId) {
    const stage = document.createElement("p");
    stage.className = "stage-readout";
    stage.append(text("strong", task.stageId));
    const dwell = text("span", duration(task.dwellMilliseconds || 0));
    if (task.stageEnteredAt !== undefined) dwell.dataset.stageEnteredAt = String(task.stageEnteredAt);
    stage.append(dwell);
    card.append(stage);
  }

  if (task.deferral) {
    const deferral = document.createElement("p");
    deferral.className = "deferral-readout";
    deferral.append(text("strong", "DEFERRED"));
    deferral.append(text("span", deferralDetail(task.deferral)));
    card.append(deferral);
  }

  if (isEpic(task)) {
    const lever = document.createElement("button");
    lever.type = "button";
    lever.className = "epic-lever";
    const target = task.status !== "in-progress";
    lever.textContent = target ? "Start epic →" : "Pause epic ∥";
    lever.addEventListener("click", async () => {
      lever.disabled = true;
      statusElement.textContent = target ? "Starting epic…" : "Pausing epic…";
      try {
        await fetchJson("/api/epics/" + task.id + "/in-progress", {
          body: JSON.stringify({ inProgress: target }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        });
        await load();
      } catch (error) {
        statusElement.dataset.error = "true";
        statusElement.textContent = error instanceof Error ? error.message : "Epic status change failed";
        lever.disabled = false;
      }
    });
    card.append(lever);
  }
  return card;
};

const renderProjection = (projection) => {
  boardElement.replaceChildren();
  for (const column of projection.columns) {
    const section = document.createElement("section");
    section.className = "column";
    section.dataset.status = column.status;
    const header = document.createElement("header");
    header.className = "column-header";
    header.append(text("h2", column.status.replaceAll("-", " ")));
    header.append(text("span", String(column.tasks.length).padStart(2, "0"), "column-count"));
    section.append(header);
    const stack = document.createElement("div");
    stack.className = "card-stack";
    if (column.tasks.length === 0) stack.append(text("p", "No work in this column", "empty-column"));
    for (const task of column.tasks) stack.append(createCard(task));
    section.append(stack);
    boardElement.append(section);
  }
};

const graphNodeWidth = 220;
const graphNodeHeight = 126;
const graphColumnGap = 90;
const graphRowGap = 30;
const graphPadding = 28;

const graphPosition = (node) => ({
  x: graphPadding + node.layer * (graphNodeWidth + graphColumnGap),
  y: graphPadding + node.row * (graphNodeHeight + graphRowGap),
});

const renderDependencyGraph = (graph) => {
  graphCanvasElement.replaceChildren();
  const maxLayer = graph.nodes.reduce((maximum, node) => Math.max(maximum, node.layer), 0);
  const maxRow = graph.nodes.reduce((maximum, node) => Math.max(maximum, node.row), 0);
  const width = graphPadding * 2 + graphNodeWidth + maxLayer * (graphNodeWidth + graphColumnGap);
  const height = Math.max(480, graphPadding * 2 + graphNodeHeight + maxRow * (graphNodeHeight + graphRowGap));
  graphCanvasElement.style.width = width + "px";
  graphCanvasElement.style.height = height + "px";

  const locations = new Map(graph.nodes.map((node) => [node.id, graphPosition(node)]));
  const edges = svg("svg", {
    "aria-hidden": "true",
    class: "graph-edges",
    height,
    viewBox: "0 0 " + width + " " + height,
    width,
  });
  const definitions = svg("defs", {});
  const arrow = svg("marker", {
    id: "dependency-arrow",
    markerHeight: 7,
    markerWidth: 7,
    orient: "auto-start-reverse",
    refX: 6,
    refY: 3.5,
    viewBox: "0 0 7 7",
  });
  arrow.append(svg("path", { d: "M 0 0 L 7 3.5 L 0 7 z", fill: "context-stroke" }));
  definitions.append(arrow);
  edges.append(definitions);
  for (const edge of graph.edges) {
    const from = locations.get(edge.from);
    const to = locations.get(edge.to);
    if (!from || !to) continue;
    const startX = from.x + graphNodeWidth;
    const startY = from.y + graphNodeHeight / 2;
    const endX = to.x;
    const endY = to.y + graphNodeHeight / 2;
    const middleX = (startX + endX) / 2;
    const path = svg("path", {
      class: "graph-edge",
      d: "M " + startX + " " + startY + " C " + middleX + " " + startY + ", " + middleX + " " + endY + ", " + endX + " " + endY,
      "data-from": edge.from,
      "data-to": edge.to,
      "data-trace": edge.trace,
    });
    edges.append(path);
  }
  graphCanvasElement.append(edges);

  for (const node of graph.nodes) {
    const position = locations.get(node.id);
    const link = document.createElement("a");
    link.className = "graph-node";
    link.dataset.taskId = String(node.id);
    link.dataset.treatment = node.treatment;
    link.href = consoleUrl("lifecycle", "task:" + node.id);
    link.style.left = position.x + "px";
    link.style.top = position.y + "px";
    link.setAttribute("aria-label", "Task #" + node.id + ", " + node.title + ", " + node.treatment + ". Open lifecycle view");
    link.setAttribute("title", node.title);
    link.append(text("span", "TASK #" + node.id, "graph-node-id"));
    link.append(text("strong", node.title, "graph-node-title"));
    link.append(text("span", node.treatment, "graph-node-state"));
    graphCanvasElement.append(link);
  }
};

const selectView = (view, scope) => {
  boardElement.hidden = view !== "board";
  graphElement.hidden = view !== "dependencies";
  lifecycleElement.hidden = view !== "lifecycle";
  boardViewLink.href = consoleUrl("board", scope);
  dependenciesViewLink.href = consoleUrl("dependencies", scope);
  if (view === "board") {
    boardViewLink.setAttribute("aria-current", "page");
    dependenciesViewLink.removeAttribute("aria-current");
    viewEyebrowElement.textContent = "KANBAN PROJECTION";
    viewTitleElement.textContent = "Delivery floor";
  } else if (view === "dependencies") {
    boardViewLink.removeAttribute("aria-current");
    dependenciesViewLink.setAttribute("aria-current", "page");
    viewEyebrowElement.textContent = "DEPENDENCY GRAPH";
    viewTitleElement.textContent = "Readiness paths";
  } else {
    boardViewLink.removeAttribute("aria-current");
    dependenciesViewLink.removeAttribute("aria-current");
    viewEyebrowElement.textContent = "LIFECYCLE CANVAS";
    viewTitleElement.textContent = "Task detail";
  }
};

const addScopeOptions = (tasks, selected) => {
  scopeElement.replaceChildren(new Option("All work", "all"));
  for (const task of tasks.filter(isEpic)) {
    scopeElement.add(new Option("Epic #" + task.id + " · " + task.title, "epic:" + task.id));
  }
  for (const task of tasks) {
    scopeElement.add(new Option("Task #" + task.id + " · " + task.title, "task:" + task.id));
  }
  scopeElement.value = [...scopeElement.options].some(({ value }) => value === selected) ? selected : "all";
};

const updateDwells = () => {
  for (const element of document.querySelectorAll("[data-stage-entered-at]")) {
    element.textContent = duration(Date.now() - Number(element.dataset.stageEnteredAt));
  }
};

const renderLoadFailure = (error) => {
  scopeElement.selectedIndex = -1;
  boardElement.replaceChildren();
  graphCanvasElement.replaceChildren();
  lifecycleTaskElement.textContent = "";
  attentionListElement.replaceChildren();
  statusElement.dataset.error = "true";
  statusElement.textContent = error instanceof Error ? error.message : "Console load failed";
};

const lifecycleViewer = () => {
  if (!window.heddleLifecycleViewer) {
    throw new Error("lifecycle renderer is unavailable");
  }
  return window.heddleLifecycleViewer;
};

const pollLifecycle = (taskId, generation, afterSequence) => {
  lifecyclePollTimer = window.setTimeout(async () => {
    if (generation !== loadGeneration) return;
    try {
      const tail = await fetchJson(
        "/api/lifecycle?task=" + taskId + "&after=" + afterSequence,
      );
      if (generation !== loadGeneration) return;
      lifecycleViewer().append(tail);
      statusElement.textContent =
        "Lifecycle live · " + tail.nextSequence + " ordered events";
      pollLifecycle(taskId, generation, tail.nextSequence);
    } catch (error) {
      if (generation !== loadGeneration) return;
      window.heddleLifecycleViewer?.clear();
      renderLoadFailure(error);
    }
  }, 1000);
};

async function load() {
  const generation = ++loadGeneration;
  window.clearTimeout(lifecyclePollTimer);
  statusElement.dataset.error = "false";
  statusElement.textContent = "Loading board…";
  const requestedScope = scopeFromUrl();
  try {
    const view = viewFromUrl();
    const [board, attention] = await Promise.all([
      fetchJson("/api/board"),
      fetchJson("/api/attention"),
    ]);
    if (generation !== loadGeneration) return;
    addScopeOptions(board.tasks, requestedScope);
    selectView(view, requestedScope);
    if (view !== "lifecycle") window.heddleLifecycleViewer?.clear();
    renderAttention(attention);
    if (view === "board") {
      const projection = await fetchJson("/api/projection?scope=" + encodeURIComponent(requestedScope));
      if (generation !== loadGeneration) return;
      renderProjection(projection);
      statusElement.textContent = projection.columns.reduce((count, column) => count + column.tasks.length, 0) + " visible records";
      updateDwells();
    } else if (view === "dependencies") {
      const graph = await fetchJson("/api/dependency-graph?scope=" + encodeURIComponent(requestedScope));
      if (generation !== loadGeneration) return;
      renderDependencyGraph(graph);
      statusElement.textContent = graph.nodes.length + " visible nodes · " + graph.edges.length + " dependency edges";
    } else {
      const match = /^task:([1-9][0-9]*)$/.exec(requestedScope);
      if (!match) throw new Error("lifecycle view requires task:<id> scope");
      const task = board.tasks.find(({ id }) => id === Number(match[1]));
      if (!task) throw new Error("lifecycle task does not exist");
      const lifecycle = await fetchJson(
        "/api/lifecycle?task=" + task.id + "&after=0",
      );
      if (generation !== loadGeneration) return;
      lifecycleTaskElement.textContent = "Task #" + task.id + " · " + task.title;
      lifecycleViewer().replace(lifecycle);
      statusElement.textContent = "Lifecycle view for task #" + task.id;
      pollLifecycle(task.id, generation, lifecycle.nextSequence);
    }
  } catch (error) {
    if (generation !== loadGeneration) return;
    window.heddleLifecycleViewer?.clear();
    renderLoadFailure(error);
  }
}

scopeElement.addEventListener("change", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("scope", scopeElement.value);
  window.history.pushState({}, "", url);
  void load();
});
window.addEventListener("popstate", () => void load());
window.setInterval(updateDwells, 30000);
void load();`;
