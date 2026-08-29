// ---
// relationships:
//   implements: heddle
// ---

export const consolePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Heddle Console</title>
    <link rel="stylesheet" href="/assets/console.css">
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
        <span class="attention-count" id="attention-count" role="status" aria-label="Attention items">0</span>
      </div>
    </header>
    <section class="control-rail" aria-label="Board controls">
      <div>
        <p class="eyebrow">KANBAN PROJECTION</p>
        <h1>Delivery floor</h1>
      </div>
      <label class="scope-control" for="scope">
        <span>SCOPE</span>
        <select id="scope" name="scope">
          <option value="all">All work</option>
        </select>
      </label>
    </section>
    <main>
      <p id="console-status" class="console-status" aria-live="polite">Loading board…</p>
      <div id="board" class="board" role="region" aria-label="Kanban board" tabindex="0"></div>
    </main>
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
  background-image: linear-gradient(rgba(25, 26, 23, 0.035) 1px, transparent 1px);
  background-size: 100% 24px;
}

button, select { font: inherit; }

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

.control-rail {
  padding: 26px clamp(18px, 3vw, 42px) 20px;
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  border-bottom: 1px solid var(--rule-dark);
}

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
  position: relative;
  padding: 13px;
  background: var(--paper-raised);
  border: 1px solid var(--rule-dark);
  box-shadow: var(--shadow);
}

.task-card::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  background: var(--rule-dark);
}

.task-card[data-status="in-progress"]::before { background: var(--active); }
.task-card[data-blocked="true"]::before { background: var(--signal); }
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

@media (max-width: 680px) {
  .masthead-state > span:not(.attention-count):not(.live-mark) { display: none; }
  .control-rail { align-items: stretch; flex-direction: column; }
  .scope-control { min-width: 0; }
}

@media (prefers-reduced-motion: no-preference) {
  .task-card { animation: settle 220ms ease-out both; }
  @keyframes settle { from { opacity: 0; transform: translateY(5px); } }
}`;

export const consoleClient = `const boardElement = document.querySelector("#board");
const scopeElement = document.querySelector("#scope");
const statusElement = document.querySelector("#console-status");
const attentionElement = document.querySelector("#attention-count");
let loadGeneration = 0;

const scopeFromUrl = () => new URL(window.location.href).searchParams.get("scope") || "all";

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
  statusElement.dataset.error = "true";
  statusElement.textContent = error instanceof Error ? error.message : "Console load failed";
};

async function load() {
  const generation = ++loadGeneration;
  statusElement.dataset.error = "false";
  statusElement.textContent = "Loading board…";
  const requestedScope = scopeFromUrl();
  try {
    const [board, projection, attention] = await Promise.all([
      fetchJson("/api/board"),
      fetchJson("/api/projection?scope=" + encodeURIComponent(requestedScope)),
      fetchJson("/api/attention"),
    ]);
    if (generation !== loadGeneration) return;
    addScopeOptions(board.tasks, requestedScope);
    renderProjection(projection);
    attentionElement.textContent = String(attention.length);
    statusElement.textContent = projection.columns.reduce((count, column) => count + column.tasks.length, 0) + " visible records";
    updateDwells();
  } catch (error) {
    if (generation !== loadGeneration) return;
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
