#!/usr/bin/env node
// ---
// relationships:
//   validates: heddle
// ---

import { spawn } from "node:child_process";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import process from "node:process";
import { clearTimeout, setTimeout as scheduleTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import { createConsoleQualificationFixture } from "./console-qualification-fixture.mjs";

const session = `heddle-console-qualification-${process.pid}`;
const phase = process.env.HEDDLE_BROWSER_PHASE ?? "all";
const fixture = await createConsoleQualificationFixture();
const observations = [];
let browserStarted = false;

class QualificationFailure extends Error {
  constructor(guard, detail) {
    super(`${guard}: ${detail}`);
    this.guard = guard;
  }
}

const invariant = (condition, guard, detail) => {
  if (!condition) throw new QualificationFailure(guard, detail);
};

const command = async (...args) => {
  const child = spawn(
    "agent-browser",
    ["--session", session, "--json", ...args],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => {
    stdout += value;
  });
  child.stderr.on("data", (value) => {
    stderr += value;
  });
  let timedOut = false;
  const timeout = scheduleTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 30_000);
  timeout.unref();
  const [code] = await once(child, "close");
  clearTimeout(timeout);
  if (timedOut) {
    throw new Error(`agent-browser ${args.join(" ")} timed out after 30s`);
  }
  if (code !== 0) {
    throw new Error(
      `agent-browser ${args.join(" ")} failed (${code}): ${stderr || stdout}`,
    );
  }
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("agent-browser returned no result");
  const result = JSON.parse(line);
  if (!result.success) {
    throw new Error(
      `agent-browser ${args.join(" ")} failed: ${JSON.stringify(result.error)}`,
    );
  }
  return result.data;
};

const evaluate = async (source) => {
  const encoded = Buffer.from(source).toString("base64");
  const data = await command("eval", "-b", encoded);
  return data.result;
};

const open = async (url) => {
  const prefix = browserStarted ? [] : ["--allowed-domains", "127.0.0.1"];
  const data = await command(...prefix, "open", url);
  browserStarted = true;
  return data;
};

const setViewport = async ({ height, width }) => {
  await command("set", "viewport", String(width), String(height));
};

const waitFor = async (condition) => {
  await command("wait", "--fn", condition);
};

const press = async (key) => {
  await command("press", key);
};

const snapshotText = async (selector) => {
  const data = await command(
    "snapshot",
    ...(selector === undefined ? [] : ["--selector", selector]),
  );
  return data.snapshot ?? data.output ?? JSON.stringify(data);
};

const axe = async () => command("a11y", "--tags", "wcag2a,wcag2aa");

const assertAxeClean = (result, context) => {
  const violations = result.violations ?? [];
  const incomplete = result.incomplete ?? [];
  invariant(
    violations.length === 0,
    "axe-wcag-a-aa",
    `${context} has ${violations.length} violation(s): ${violations
      .map(({ id }) => id)
      .join(", ")} ${JSON.stringify(
      violations.flatMap(({ nodes }) =>
        (nodes ?? []).map(({ failureSummary, html, target }) => ({
          failureSummary,
          html,
          target,
        })),
      ),
    )}`,
  );
  invariant(
    incomplete.length === 0,
    "axe-incomplete-disposition",
    `${context} has ${incomplete.length} incomplete result(s): ${incomplete
      .map(({ id }) => id)
      .join(", ")} ${JSON.stringify(
      incomplete.flatMap(({ nodes }) =>
        (nodes ?? []).map(({ failureSummary, html, target }) => ({
          failureSummary,
          html,
          target,
        })),
      ),
    )}`,
  );
};

const assertAxeRuleAbsent = (result, ruleId, guard) => {
  invariant(
    ![...(result.violations ?? []), ...(result.incomplete ?? [])].some(
      ({ id }) => id === ruleId,
    ),
    guard,
    `${ruleId} was accepted`,
  );
};

const channel = (value) => {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
};

const luminance = (rgb) =>
  channel(rgb[0]) * 0.2126 +
  channel(rgb[1]) * 0.7152 +
  channel(rgb[2]) * 0.0722;

const contrast = (foreground, background) => {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
};

const computedContrastTargets = async (targets) =>
  evaluate(`(() => {
    const targets = ${JSON.stringify(targets)};
    const parse = (value) => [...value.matchAll(/[0-9.]+/g)].map(({ 0: item }) => Number(item));
    return targets.map((target) => {
      const element = document.querySelector(target);
      const backgrounds = [];
      let ancestor = element;
      while (ancestor) {
        const values = parse(getComputedStyle(ancestor).backgroundColor);
        if ((values[3] ?? 1) > 0) backgrounds.push(values);
        if ((values[3] ?? 1) >= 1) break;
        ancestor = ancestor.parentElement;
      }
      const style = getComputedStyle(element);
      return {
        backgrounds,
        color: parse(style.color).slice(0, 3),
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseInt(style.fontWeight, 10),
        inLifecycleControl: element.closest(".lifecycle-canvas-controls") !== null,
        inLifecycleHeader:
          element.closest("#lifecycle-view > .lifecycle-header") !== null,
        inLifecycleNode: element.closest("[data-shape-id^='shape:'] .tl-html-container") !== null,
        inLifecycleStatus: element.matches("#console-status"),
        target,
      };
    });
  })()`);

const effectiveBackground = (backgrounds) => {
  const outer = backgrounds.at(-1);
  invariant(
    outer !== undefined && (outer[3] ?? 1) >= 1,
    "computed-contrast-background",
    `background chain is not opaque: ${JSON.stringify(backgrounds)}`,
  );
  let result = outer.slice(0, 3);
  for (let index = backgrounds.length - 2; index >= 0; index -= 1) {
    const layer = backgrounds[index];
    const alpha = layer[3] ?? 1;
    result = layer
      .slice(0, 3)
      .map(
        (value, channelIndex) =>
          value * alpha + result[channelIndex] * (1 - alpha),
      );
  }
  return result;
};

const assertComputedContrast = (items, guard) => {
  for (const item of items) {
    const ratio = contrast(item.color, effectiveBackground(item.backgrounds));
    const large =
      item.fontSize >= 24 || (item.fontSize >= 18.66 && item.fontWeight >= 700);
    invariant(
      ratio >= (large ? 3 : 4.5),
      guard,
      `${item.target} has deterministic contrast ${ratio.toFixed(2)}:1 (${JSON.stringify(item)})`,
    );
  }
};

const assertLifecycleAxe = async (result, context) => {
  const violations = result.violations ?? [];
  invariant(
    violations.length === 0,
    "axe-wcag-a-aa",
    `${context} has ${violations.length} violation(s): ${JSON.stringify(
      violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.flatMap(({ target }) => target),
      })),
    )}`,
  );
  const incomplete = result.incomplete ?? [];
  invariant(
    incomplete.length === 1 && incomplete[0].id === "color-contrast",
    "axe-incomplete-disposition",
    `${context} has an unexpected incomplete set: ${incomplete
      .map(({ id }) => id)
      .join(", ")}`,
  );
  const targets = incomplete[0].nodes.flatMap(({ target }) => target);
  const computed = await computedContrastTargets(targets);
  const outside = computed.filter(
    (item) =>
      !item.inLifecycleNode &&
      !item.inLifecycleControl &&
      !item.inLifecycleHeader &&
      !item.inLifecycleStatus,
  );
  invariant(
    outside.length === 0,
    "axe-incomplete-disposition",
    `${JSON.stringify(outside.map(({ target }) => target))} are outside the bounded lifecycle canvas disposition`,
  );
  assertComputedContrast(computed, "lifecycle-node-contrast");
  observations.push({
    context,
    disposition:
      "axe cannot determine lifecycle-node, overlaid control, lifecycle-heading, or lifecycle-status backgrounds because tldraw layers overlap; computed foreground/background contrast is checked for every bounded incomplete target",
    incomplete: incomplete[0].nodes.length,
  });
};

const assertMobileBoardAxe = async (result, context) => {
  const violations = result.violations ?? [];
  invariant(
    violations.length === 0,
    "axe-wcag-a-aa",
    `${context} has ${violations.length} violation(s)`,
  );
  const incomplete = result.incomplete ?? [];
  invariant(
    incomplete.length === 1 && incomplete[0].id === "color-contrast",
    "axe-incomplete-disposition",
    `${context} has an unexpected incomplete set`,
  );
  const nodes = incomplete[0].nodes;
  invariant(
    nodes.length > 0 &&
      nodes.every(
        ({ failureSummary, target }) =>
          failureSummary?.includes("partially obscured") &&
          target.every((selector) => selector.includes(".column")),
      ),
    "axe-incomplete-disposition",
    `${context} incomplete results exceed horizontally obscured column headers`,
  );
  const computed = await computedContrastTargets(
    nodes.flatMap(({ target }) => target),
  );
  assertComputedContrast(computed, "board-column-contrast");
  observations.push({
    context,
    disposition:
      "axe cannot determine horizontally clipped column-header backgrounds; effective foreground/background contrast and keyboard scrolling are checked independently",
    incomplete: nodes.length,
  });
};

const assertPageReady = async (expected) => {
  await waitFor(
    `document.querySelector("#console-status")?.dataset.error === "false" && document.querySelector("#console-status")?.textContent?.includes(${JSON.stringify(expected)})`,
  );
};

const settleVisuals = async () => {
  await waitFor(
    `[...document.getAnimations()].every((animation) => animation.playState === "finished")`,
  );
};

const assertShellSemantics = async (view) => {
  const tree = await snapshotText();
  if (view === "attention") {
    invariant(
      tree.includes("Attention required") &&
        tree.includes("Close attention queue"),
      "computed-accessible-name",
      "attention modal lacks its computed dialog or close-control name",
    );
    return tree;
  }
  invariant(
    tree.includes("Heddle console home"),
    "computed-accessible-name",
    `${view} lacks the computed home name`,
  );
  invariant(
    tree.includes("Attention items"),
    "computed-accessible-name",
    `${view} lacks the computed attention status name`,
  );
  invariant(
    tree.includes("Console views"),
    "computed-accessible-name",
    `${view} lacks the computed navigation name`,
  );
  invariant(
    tree.includes("Board controls"),
    "computed-accessible-name",
    `${view} lacks the computed controls region name`,
  );
  return tree;
};

const resetPageEvidence = async () => {
  await command("console", "--clear");
  await command("errors", "--clear");
  await command("network", "requests", "--clear");
};

const assertNoRuntimeOrNetworkErrors = async (origin, context) => {
  const [consoleResult, runtimeResult, networkResult] = await Promise.all([
    command("console"),
    command("errors"),
    command("network", "requests"),
  ]);
  const messages = consoleResult.messages ?? [];
  const errors = runtimeResult.errors ?? [];
  const requests = networkResult.requests ?? [];
  invariant(
    messages.length === 0,
    "browser-console",
    `${context} emitted ${messages.length} console message(s)`,
  );
  invariant(
    errors.length === 0,
    "browser-runtime",
    `${context} emitted ${errors.length} runtime error(s)`,
  );
  for (const request of requests) {
    const url = new URL(request.url);
    const resourceType = String(
      request.resourceType ?? request.type ?? "",
    ).toLowerCase();
    if (
      (url.protocol === "data:" && request.url.startsWith("data:image/")) ||
      (url.protocol === "blob:" && resourceType === "image")
    ) {
      continue;
    }
    invariant(
      url.origin === origin,
      "browser-network-origin",
      `${context} requested external URL ${url.href} (${JSON.stringify(request)})`,
    );
    const status = request.status ?? request.responseStatus;
    invariant(
      status === undefined || (status >= 200 && status < 400),
      "browser-network-status",
      `${context} request ${url.pathname} failed with ${status}`,
    );
  }
  observations.push({
    consoleMessages: messages.length,
    context,
    externalRequests: 0,
    failedRequests: requests.filter((request) => {
      const status = request.status ?? request.responseStatus;
      return status !== undefined && (status < 200 || status >= 400);
    }).length,
    runtimeErrors: errors.length,
  });
};

const activeElementState = () =>
  evaluate(`(() => {
    const element = document.activeElement;
    const style = getComputedStyle(element);
    return {
      ariaLabel: element?.getAttribute?.("aria-label"),
      className: element?.className,
      id: element?.id,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      tagName: element?.tagName,
    };
  })()`);

const assertFocused = async (selector, context) => {
  const state = await evaluate(`(() => {
    const element = document.activeElement;
    const style = getComputedStyle(element);
    return {
      matches: element?.matches(${JSON.stringify(selector)}) ?? false,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  })()`);
  invariant(
    state.matches,
    "keyboard-focus-order",
    `${context} focused ${JSON.stringify(await activeElementState())} instead of ${selector}`,
  );
  invariant(
    state.outlineStyle !== "none" && state.outlineWidth >= 2,
    "visible-focus-indicator",
    `${context} has no visible two-pixel focus indicator`,
  );
};

const assertBoardKeyboard = async (baseUrl) => {
  fixture.reset();
  await open(`${baseUrl}/?scope=epic%3A40`);
  await assertPageReady("4 visible records");
  await evaluate(`document.querySelector(".wordmark").focus()`);
  for (const [selector, name] of [
    ["#attention-toggle", "attention toggle"],
    ["#board-view-link", "board navigation"],
    ["#dependencies-view-link", "dependency navigation"],
    ["#scope", "scope control"],
    ["#board", "board region"],
  ]) {
    await press("Tab");
    await assertFocused(selector, name);
  }
  const overflow = await evaluate(`(() => {
    const element = document.querySelector("#board");
    element.scrollLeft = 0;
    return element.scrollWidth > element.clientWidth;
  })()`);
  invariant(
    overflow,
    "keyboard-board-scroll-access",
    "board is not horizontally overflowed",
  );
  await press("ArrowRight");
  await waitFor(`document.querySelector("#board").scrollLeft > 0`);
  invariant(
    (await evaluate(`document.querySelector("#board").scrollLeft`)) > 0,
    "keyboard-board-scroll-access",
    "ArrowRight did not move the focused board",
  );
  await press("Tab");
  await assertFocused(".epic-lever", "epic lever");
  await press("Enter");
  await waitFor(
    `document.querySelector("#console-status")?.textContent === "4 visible records"`,
  );
  invariant(
    JSON.stringify(fixture.boardWrites()) ===
      JSON.stringify([{ inProgress: false, taskId: 40 }]),
    "keyboard-authorized-action",
    "Enter did not dispatch the exact epic pause contract",
  );
};

const assertSafeEpicControls = async (baseUrl) => {
  for (const [status, expectedLabels] of [
    ["uat", ["Pause epic ∥"]],
    ["done", []],
  ]) {
    fixture.reset();
    fixture.setEpicStatus(status);
    await open(`${baseUrl}/?scope=epic%3A40`);
    await assertPageReady("4 visible records");
    const labels = await evaluate(
      `[...document.querySelectorAll(".epic-lever")].map(({ textContent }) => textContent)`,
    );
    invariant(
      JSON.stringify(labels) === JSON.stringify(expectedLabels),
      "safe-epic-controls",
      `${status} rendered ${JSON.stringify(labels)} instead of ${JSON.stringify(expectedLabels)}`,
    );
  }
};

const exerciseShellControls = async (baseUrl) => {
  fixture.reset();
  await setViewport({ height: 1000, width: 1440 });
  await open(`${baseUrl}/?scope=all`);
  await assertPageReady("4 visible records");
  await evaluate(`document.querySelector(".wordmark").focus()`);
  await press("Tab");
  await assertFocused("#attention-toggle", "attention toggle activation");
  await press("Enter");
  await waitFor(`document.querySelector("#attention-overlay").open === true`);
  await assertFocused("#attention-close", "attention close activation");
  await press("Enter");
  await waitFor(`document.querySelector("#attention-overlay").open === false`);
  invariant(
    (await evaluate(
      `document.querySelector("#attention-toggle").getAttribute("aria-expanded")`,
    )) === "false",
    "keyboard-shell-control-activation",
    "attention close did not restore the collapsed toggle state",
  );

  await evaluate(`document.querySelector(".wordmark").focus()`);
  for (let index = 0; index < 3; index += 1) await press("Tab");
  await assertFocused(
    "#dependencies-view-link",
    "dependency navigation activation",
  );
  await press("Enter");
  await waitFor(
    `document.querySelector("#dependency-graph").hidden === false && new URL(window.location.href).searchParams.get("view") === "dependencies"`,
  );
  await assertPageReady("4 visible nodes");

  await evaluate(`document.querySelector(".wordmark").focus()`);
  for (let index = 0; index < 2; index += 1) await press("Tab");
  await assertFocused("#board-view-link", "board navigation activation");
  await press("Enter");
  await waitFor(
    `document.querySelector("#board").hidden === false && new URL(window.location.href).searchParams.get("view") === null`,
  );
  await assertPageReady("4 visible records");

  await command("focus", "#scope");
  await assertFocused("#scope", "scope activation");
  await evaluate(`(() => {
    const scope = document.querySelector("#scope");
    scope.value = "epic:40";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await delay(100);
  const scopeState = await evaluate(`(() => ({
    scope: document.querySelector("#scope").value,
    status: document.querySelector("#console-status")?.textContent,
    url: window.location.href,
  }))()`);
  invariant(
    new URL(scopeState.url).searchParams.get("scope") === "epic:40" &&
      scopeState.status === "4 visible records",
    "keyboard-shell-control-activation",
    `scope control selection was not applied: ${JSON.stringify(scopeState)}`,
  );
};

const dependencyGeometry = () =>
  evaluate(`(() => {
    const canvas = document.querySelector("#graph-canvas");
    const nodes = [...canvas.querySelectorAll(".graph-node")].map((node) => {
      const rect = node.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      return {
        ariaLabel: node.getAttribute("aria-label"),
        height: rect.height,
        id: Number(node.dataset.taskId),
        left: rect.left - canvasRect.left,
        title: node.getAttribute("title"),
        top: rect.top - canvasRect.top,
        width: rect.width,
      };
    });
    const edges = [...canvas.querySelectorAll(".graph-edge")].map((edge) => ({
      d: edge.getAttribute("d"),
      from: Number(edge.dataset.from),
      to: Number(edge.dataset.to),
    }));
    return { edges, nodes };
  })()`);

const coordinates = (path) =>
  [...path.matchAll(/-?[0-9]+(?:\.[0-9]+)?/g)].map(({ 0: value }) =>
    Number(value),
  );

const assertDependencyGeometry = (geometry) => {
  const byId = new Map(geometry.nodes.map((node) => [node.id, node]));
  for (const node of geometry.nodes) {
    invariant(
      node.height === 126,
      "dependency-node-height",
      `task ${node.id} has ${node.height}px border-box height`,
    );
    invariant(
      node.ariaLabel?.includes(node.title),
      "dependency-full-accessible-title",
      `task ${node.id} accessible name does not retain its full title`,
    );
  }
  const columns = Map.groupBy(geometry.nodes, ({ left }) => left);
  for (const nodes of columns.values()) {
    const ordered = nodes.toSorted((left, right) => left.top - right.top);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      invariant(
        current.top - (previous.top + previous.height) > 0,
        "dependency-node-spacing",
        `tasks ${previous.id} and ${current.id} overlap or touch`,
      );
    }
  }
  for (const edge of geometry.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const values = coordinates(edge.d);
    invariant(
      values.length >= 8,
      "dependency-edge-anchor",
      `edge ${edge.from}->${edge.to} has an unreadable path`,
    );
    const [startX, startY] = values;
    const endX = values.at(-2);
    const endY = values.at(-1);
    invariant(
      startX === from.left + from.width &&
        startY === from.top + from.height / 2,
      "dependency-edge-anchor",
      `edge ${edge.from}->${edge.to} misses the source center anchor`,
    );
    invariant(
      endX === to.left && endY === to.top + to.height / 2,
      "dependency-edge-anchor",
      `edge ${edge.from}->${edge.to} misses the target center anchor`,
    );
  }
};

const assertDependencyKeyboard = async (baseUrl) => {
  fixture.reset();
  await open(`${baseUrl}/?view=dependencies&scope=epic%3A40`);
  await assertPageReady("4 visible nodes");
  await evaluate(`document.querySelector("#scope").focus()`);
  await press("Tab");
  await assertFocused("#graph-viewport", "dependency graph viewport");
  const overflow = await evaluate(`(() => {
    const element = document.querySelector("#graph-viewport");
    element.scrollLeft = 0;
    return element.scrollWidth > element.clientWidth;
  })()`);
  invariant(
    overflow,
    "keyboard-scroll-access",
    "dependency graph is not horizontally overflowed",
  );
  for (let index = 0; index < 4; index += 1) await press("ArrowRight");
  await waitFor(`document.querySelector("#graph-viewport").scrollLeft > 0`);
  const scrollLeft = await evaluate(
    `document.querySelector("#graph-viewport").scrollLeft`,
  );
  invariant(
    scrollLeft > 0,
    "keyboard-scroll-access",
    "ArrowRight did not move the focused dependency graph",
  );
  await evaluate(
    `document.querySelector('.graph-node[data-task-id="43"]').focus()`,
  );
  await press("Enter");
  await waitFor(
    `new URL(window.location.href).searchParams.get("view") === "lifecycle" && document.querySelector("#lifecycle-view")?.hidden === false`,
  );
};

const editorControlRosters = {
  closed: [{ disabled: false, label: "EDIT BLUEPRINT", type: "button" }],
  unavailable: [{ disabled: true, label: "EDIT BLUEPRINT", type: "button" }],
  open: [
    { disabled: false, label: "SAVE ARTIFACT", type: "button" },
    { disabled: false, label: "CLOSE EDITOR", type: "button" },
  ],
  saving: [
    { disabled: true, label: "SAVING…", type: "button" },
    { disabled: true, label: "CLOSE EDITOR", type: "button" },
  ],
};

const canvasControlRoster = [
  { ariaLabel: "Zoom out", label: "−", title: "Zoom out" },
  { ariaLabel: "Zoom in", label: "+", title: "Zoom in" },
  { ariaLabel: null, label: "FIT", title: "Fit readable graph" },
  { ariaLabel: null, label: "CURRENT", title: "Focus current stage" },
];

const editorControlRoster = () =>
  evaluate(`(() => {
    const actions = document.querySelector(".blueprint-editor-actions");
    const control = (element) => ({
      disabled: element.disabled,
      label: element.textContent.trim().replace(/\\s+/g, " "),
      type: element.getAttribute("type"),
    });
    return {
      all: [...actions.querySelectorAll("button")].map(control),
      direct: [...actions.querySelectorAll(":scope > button")].map(control),
    };
  })()`);

const assertEditorControlRoster = async (
  state,
  guard = "editor-control-roster",
) => {
  const expected = editorControlRosters[state];
  const actual = await editorControlRoster();
  invariant(
    JSON.stringify(actual) ===
      JSON.stringify({ all: expected, direct: expected }),
    guard,
    `${state} editor controls are ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`,
  );
};

const assertReadOnlySurface = async (editorState = "closed") => {
  const expectedEditorControls = editorControlRosters[editorState];
  const expectedCanvasControls =
    editorState === "closed" ? canvasControlRoster : [];
  const result = await evaluate(`(() => {
    const expectedEditorControls = ${JSON.stringify(expectedEditorControls)};
    const expectedCanvasControls = ${JSON.stringify(expectedCanvasControls)};
    const editorActions = document.querySelector(".blueprint-editor-actions");
    const editorButtons = [...editorActions.querySelectorAll("button")];
    const editorControl = (element) => ({
      disabled: element.disabled,
      label: element.textContent.trim().replace(/\\s+/g, " "),
      type: element.getAttribute("type"),
    });
    const acceptedEditorButtons =
      JSON.stringify(editorButtons.map(editorControl)) === JSON.stringify(expectedEditorControls) &&
      JSON.stringify([...editorActions.querySelectorAll(":scope > button")].map(editorControl)) === JSON.stringify(expectedEditorControls)
        ? new Set(editorButtons)
        : new Set();
    const rebaseControls = [...document.querySelectorAll(
      ".lifecycle-rebase-controls select, .lifecycle-rebase-controls button",
    )];
    const acceptedRebaseControls =
      rebaseControls.length === 2 &&
      rebaseControls[0].matches("select#lifecycle-rebase-target") &&
      rebaseControls[1].matches("button[type='button']") &&
      ["REBASE INSTANCE", "REBASING…"].includes(
        rebaseControls[1].textContent.trim(),
      )
        ? new Set(rebaseControls)
        : new Set();
    const canvasButtons = [...document.querySelectorAll(
      ".lifecycle-canvas-controls > button",
    )];
    const canvasControl = (element) => ({
      ariaLabel: element.getAttribute("aria-label"),
      label: element.textContent.trim(),
      title: element.getAttribute("title"),
    });
    const acceptedCanvasControls =
      JSON.stringify(canvasButtons.map(canvasControl)) ===
        JSON.stringify(expectedCanvasControls)
        ? new Set(canvasButtons)
        : new Set();
    const tabbableMutation = [...document.querySelectorAll(
      "#board button, #board input, #board textarea, #dependency-graph button, #dependency-graph input, #dependency-graph textarea, #lifecycle-view button, #lifecycle-view input, #lifecycle-view textarea, [contenteditable='true']",
    )].filter((element) => {
      if (
        element.disabled ||
        element.tabIndex < 0 ||
        element.matches(".epic-lever") ||
        acceptedEditorButtons.has(element) ||
        acceptedCanvasControls.has(element) ||
        acceptedRebaseControls.has(element)
      ) {
        return false;
      }
      return !element.getAttribute("title")?.startsWith("The tldraw SDK requires a license key");
    });
    return {
      draggableCards: document.querySelectorAll(".task-card[draggable='true']").length,
      editableCards: document.querySelectorAll(".task-card[contenteditable='true']").length,
      prohibited: tabbableMutation.map((element) => element.outerHTML.slice(0, 180)),
    };
  })()`);
  invariant(
    result.draggableCards === 0 && result.editableCards === 0,
    "read-only-console",
    "a console projection exposes draggable or editable task state",
  );
  invariant(
    result.prohibited.length === 0,
    "read-only-console",
    `a prohibited mutation control is keyboard reachable: ${result.prohibited.join(", ")}`,
  );
};

const waitForBlueprintRequestCount = async (field, count, guard) => {
  const deadline = Date.now() + 5_000;
  while (
    fixture.blueprintRequests()[field].length < count &&
    Date.now() < deadline
  ) {
    await delay(20);
  }
  const requests = fixture.blueprintRequests();
  invariant(
    requests[field].length === count,
    guard,
    `expected ${count} editor ${field}, observed ${JSON.stringify(requests)}`,
  );
  return requests;
};

const editorStatus = () =>
  evaluate(`(() => ({
    activeLabel: document.activeElement?.textContent?.trim().replace(/\\s+/g, " ") ?? "",
    activeTag: document.activeElement?.tagName ?? "",
    error: document.querySelector(".blueprint-editor-status").dataset.error,
    text: document.querySelector(".blueprint-editor-status").textContent.trim().replace(/\\s+/g, " "),
  }))()`);

const assertBlueprintNetwork = async () => {
  const network = await command("network", "requests");
  const requests = (network.requests ?? [])
    .filter(
      ({ url }) => new URL(url).pathname === "/api/blueprints/room-refresh",
    )
    .map((request) => ({
      method: request.method ?? request.requestMethod,
      status: request.status ?? request.responseStatus,
    }));
  invariant(
    JSON.stringify(requests.map(({ method }) => method)) ===
      JSON.stringify(["GET", "PUT"]),
    "editor-network-contract",
    `editor request methods are ${JSON.stringify(requests)}`,
  );
  invariant(
    requests.every(
      ({ status }) => status !== undefined && status >= 200 && status < 300,
    ),
    "editor-network-contract",
    `editor request statuses are ${JSON.stringify(requests)}`,
  );
};

const beginBlueprintEditing = async (
  baseUrl,
  guard = "editor-edit-activation",
) => {
  fixture.reset();
  fixture.prepareBlueprintEditor();
  await setViewport({ height: 1000, width: 1440 });
  await resetPageEvidence();
  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await assertEditorControlRoster("closed");
  await assertReadOnlySurface("closed");
  await command("focus", ".blueprint-editor-actions button");
  await assertFocused(
    ".blueprint-editor-actions button:first-child",
    "edit blueprint activation",
  );
  await press("Enter");
  await waitForBlueprintRequestCount("loads", 1, guard);
  await waitFor(
    `document.querySelector(".blueprint-editor-status")?.textContent === "Loading repository artifact…"`,
  );
  const loading = await editorStatus();
  invariant(
    loading.activeLabel === "EDIT BLUEPRINT" && loading.error === "false",
    guard,
    `loading state or focus is ${JSON.stringify(loading)}`,
  );
  await assertEditorControlRoster("closed");
  await assertReadOnlySurface("closed");

  fixture.releaseBlueprintLoad();
  await waitFor(
    `document.querySelector(".blueprint-editor-status")?.textContent?.startsWith("Editing blueprints/room-refresh.json") && document.querySelectorAll(".blueprint-editor-actions button").length === 2`,
  );
  await assertEditorControlRoster("open");
  await assertReadOnlySurface("open");
  const opened = await editorStatus();
  invariant(
    opened.activeTag === "BUTTON" &&
      opened.activeLabel === "SAVE ARTIFACT" &&
      opened.error === "false" &&
      opened.text ===
        "Editing blueprints/room-refresh.json · running instance stays pinned to aaaaaaaaaaaa",
    guard,
    `opened state or focus is ${JSON.stringify(opened)}`,
  );
  const loaded = await waitForBlueprintRequestCount("loadResults", 1, guard);
  invariant(
    JSON.stringify(loaded.loads) === JSON.stringify(["room-refresh"]),
    guard,
    `editor load target is ${JSON.stringify(loaded.loads)}`,
  );
  return loaded.loadResults[0];
};

const exerciseBlueprintEditor = async (baseUrl) => {
  const loaded = await beginBlueprintEditing(baseUrl);
  await command("focus", ".blueprint-editor-actions button:first-child");
  await assertFocused(
    ".blueprint-editor-actions button:first-child",
    "save artifact activation",
  );
  await press("Enter");
  let requests = await waitForBlueprintRequestCount(
    "saves",
    1,
    "editor-save-activation",
  );
  await waitFor(
    `document.querySelector(".blueprint-editor-status")?.textContent === "Validating and saving repository artifact…"`,
  );
  await assertEditorControlRoster("saving");
  await assertReadOnlySurface("saving");
  const saving = await editorStatus();
  invariant(
    saving.activeTag === "BODY" && saving.error === "false",
    "editor-save-activation",
    `saving state or focus is ${JSON.stringify(saving)}`,
  );
  const [save] = requests.saves;
  invariant(
    save.artifactId === "room-refresh" &&
      save.expectedBlobHash === loaded.blobHash &&
      JSON.stringify(save.nodes) === JSON.stringify(loaded.blueprint.nodes) &&
      JSON.stringify(save.edges) === JSON.stringify(loaded.blueprint.edges) &&
      JSON.stringify(save.positions) === JSON.stringify(loaded.positions),
    "editor-save-activation",
    `no-change save contract is ${JSON.stringify(save)}`,
  );

  fixture.releaseBlueprintSave();
  requests = await waitForBlueprintRequestCount(
    "saveResults",
    1,
    "editor-save-activation",
  );
  const saved = requests.saveResults[0];
  await waitFor(
    `document.querySelector(".blueprint-editor-status")?.textContent === ${JSON.stringify(`Saved blueprints/room-refresh.json · artifact ${saved.blobHash.slice(0, 12)}`)}`,
  );
  await assertEditorControlRoster("open");
  await assertReadOnlySurface("open");
  const savedState = await editorStatus();
  invariant(
    savedState.activeTag === "BODY" && savedState.error === "false",
    "editor-save-activation",
    `saved state or focus is ${JSON.stringify(savedState)}`,
  );

  await command("focus", ".blueprint-editor-actions button:last-child");
  await assertFocused(
    ".blueprint-editor-actions button:last-child",
    "close editor activation",
  );
  await press("Enter");
  await waitFor(
    `document.querySelector(".blueprint-editor-status")?.textContent === "" && document.querySelectorAll(".blueprint-editor-actions button").length === 1`,
  );
  await assertEditorControlRoster("closed");
  await assertReadOnlySurface("closed");
  const closed = await editorStatus();
  invariant(
    closed.activeTag === "BODY" && closed.error === "false",
    "editor-close-activation",
    `closed state or focus is ${JSON.stringify(closed)}`,
  );
  invariant(
    fixture.blueprintRequests().loads.length === 1 &&
      fixture.blueprintRequests().saves.length === 1,
    "editor-close-activation",
    `close triggered an unexpected repository request: ${JSON.stringify(fixture.blueprintRequests())}`,
  );
  await assertBlueprintNetwork();
  await assertNoRuntimeOrNetworkErrors(
    new URL(baseUrl).origin,
    "blueprint editor keyboard contract",
  );
};

const waitForAction = async () => {
  const deadline = Date.now() + 5_000;
  while (fixture.actions().length === 0 && Date.now() < deadline) {
    await delay(20);
  }
  invariant(
    fixture.actions().length === 1,
    "keyboard-authorized-action",
    "attention action was not dispatched exactly once",
  );
  return fixture.actions()[0];
};

const openAttentionEntry = async (baseUrl, attentionId) => {
  fixture.reset();
  await open(
    `${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40&attention=${encodeURIComponent(attentionId)}`,
  );
  await waitFor(
    `document.querySelector('.attention-entry[data-attention-id=${JSON.stringify(attentionId)}]')?.dataset.focused === "true"`,
  );
};

const exerciseAttentionActions = async (baseUrl) => {
  await openAttentionEntry(baseUrl, "choice-a");
  await press("Tab");
  await assertFocused(
    '.attention-entry[data-attention-id="choice-a"] input[value="Compact"]',
    "escalation option",
  );
  await press("Space");
  await press("Tab");
  await assertFocused(
    'textarea[name="layout:text"]',
    "question text alternative",
  );
  await press("Tab");
  await assertFocused(
    'textarea[name="layout:reasoning"]',
    "question reasoning",
  );
  await command(
    "fill",
    'textarea[name="layout:reasoning"]',
    "The smaller arrangement fits.",
  );
  await press("Tab");
  await assertFocused(
    '.attention-entry[data-attention-id="choice-a"] .attention-action',
    "escalation answer",
  );
  await press("Enter");
  let action = await waitForAction();
  invariant(
    action.action.contract.kind === "escalation.answer" &&
      JSON.stringify(action.answers.layout) ===
        JSON.stringify({
          selectedOptions: ["Compact"],
          text: "",
          reasoning: "The smaller arrangement fits.",
        }),
    "keyboard-authorized-action",
    "escalation answer did not preserve the offered target and value",
  );

  for (const [actionId, tabs, decision] of [
    ["accept", 1, "accept"],
    ["reject", 2, "reject"],
  ]) {
    await openAttentionEntry(baseUrl, "approval-a");
    for (let index = 0; index < tabs; index += 1) await press("Tab");
    await assertFocused(
      `.attention-entry[data-attention-id="approval-a"] .attention-action`,
      `approval ${actionId}`,
    );
    await press("Enter");
    action = await waitForAction();
    invariant(
      action.action.actionId === actionId &&
        action.action.contract.decision === decision,
      "keyboard-authorized-action",
      `approval ${actionId} dispatched the wrong contract`,
    );
  }

  await openAttentionEntry(baseUrl, "input-a");
  await press("Tab");
  await assertFocused(
    '.attention-entry[data-attention-id="input-a"] input[value="Compact"]',
    "user-input option",
  );
  await press("Space");
  await press("Tab");
  await assertFocused(
    'textarea[name="placement:text"]',
    "user-input text alternative",
  );
  await command(
    "fill",
    'textarea[name="placement:text"]',
    "A custom arrangement",
  );
  invariant(
    (await evaluate(
      "document.querySelectorAll('.attention-entry[data-attention-id=\"input-a\"] input:checked').length",
    )) === 0,
    "question-answer-exclusivity",
    "Typing an answer did not clear the selected option",
  );
  await press("Tab");
  await assertFocused(
    'textarea[name="placement:reasoning"]',
    "user-input reasoning",
  );
  await command(
    "fill",
    'textarea[name="placement:reasoning"]',
    "The custom arrangement fits.",
  );
  await press("Tab");
  await assertFocused(
    '.attention-entry[data-attention-id="input-a"] .attention-action',
    "user-input response",
  );
  await press("Enter");
  action = await waitForAction();
  invariant(
    action.action.contract.kind === "t3.user-input.respond" &&
      JSON.stringify(action.answers.placement) ===
        JSON.stringify({
          selectedOptions: [],
          text: "A custom arrangement",
          reasoning: "The custom arrangement fits.",
        }),
    "keyboard-authorized-action",
    "user-input response did not preserve the offered target and value",
  );

  for (const attentionId of ["stale-a", "repository-a"]) {
    await openAttentionEntry(baseUrl, attentionId);
    const interactive = await evaluate(
      `document.querySelector('.attention-entry[data-attention-id=${JSON.stringify(attentionId)}]').querySelectorAll("button,input,select,textarea").length`,
    );
    invariant(
      interactive === 0,
      "read-only-attention",
      `${attentionId} invents an unauthorized action`,
    );
  }
};

const assertAttentionHeadings = async () => {
  const expected = fixture.attentionHeadings;
  const rendered =
    await evaluate(`([...document.querySelectorAll(".attention-entry")].map((entry) => ({
    attentionId: entry.dataset.attentionId,
    heading: entry.querySelector("h3")?.textContent,
    headingTag: entry.querySelector("h3")?.tagName,
  })))`);
  const byId = new Map(rendered.map((entry) => [entry.attentionId, entry]));
  const missingOrChanged = expected.filter(({ attentionId, heading }) => {
    const actual = byId.get(attentionId);
    return actual?.headingTag !== "H3" || actual.heading !== heading;
  });
  invariant(
    missingOrChanged.length === 0,
    "attention-readable-headings",
    `attention headings differ from kind and scope: ${JSON.stringify({ missingOrChanged, rendered })}`,
  );
  const renderedKinds = [...new Set(expected.map(({ kind }) => kind))].sort();
  const currentKinds = [...fixture.currentAttentionKinds].sort();
  invariant(
    JSON.stringify(renderedKinds) === JSON.stringify(currentKinds),
    "attention-category-coverage",
    `browser fixture covers ${JSON.stringify(renderedKinds)} instead of ${JSON.stringify(currentKinds)}`,
  );
  const leaked = expected.flatMap(({ attentionId, fingerprint, instanceId }) =>
    rendered
      .filter(({ heading }) =>
        [attentionId, fingerprint, instanceId]
          .filter((identifier) => identifier !== undefined)
          .some((identifier) => heading?.includes(identifier)),
      )
      .map(({ heading }) => ({ attentionId, heading })),
  );
  invariant(
    leaked.length === 0,
    "attention-heading-identity-safety",
    `attention headings expose internal identity: ${JSON.stringify(leaked)}`,
  );
  const tree = (await snapshotText("#attention-list")).toLowerCase();
  invariant(
    expected.every(({ heading }) => tree.includes(heading.toLowerCase())),
    "attention-accessible-headings",
    "the accessibility tree does not contain every attention heading",
  );
};

const assertAttentionNoHorizontalOverflow = async (context) => {
  const overflow = await evaluate(`(() => {
    const surfaces = [
      document.querySelector("#attention-overlay"),
      document.querySelector(".attention-sheet"),
      document.querySelector("#attention-list"),
      ...document.querySelectorAll(".attention-entry"),
    ];
    return surfaces.map((element) => ({
      attentionId: element.dataset.attentionId,
      className: element.className,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    })).filter(({ clientWidth, scrollWidth }) => scrollWidth > clientWidth);
  })()`);
  invariant(
    overflow.length === 0,
    "attention-no-horizontal-overflow",
    `${context} has horizontal overflow: ${JSON.stringify(overflow)}`,
  );
};

const assertAttentionLayout = async (attentionId, context) => {
  const state = await evaluate(`(() => {
    const dialog = document.querySelector("#attention-overlay");
    const header = document.querySelector(".attention-header");
    const status = document.querySelector("#attention-status");
    const list = document.querySelector("#attention-list");
    const entry = document.querySelector('.attention-entry[data-attention-id=${JSON.stringify(attentionId)}]');
    const before = {
      dialogScroll: dialog.scrollTop,
      headerTop: header.getBoundingClientRect().top,
      statusTop: status.getBoundingClientRect().top,
    };
    list.scrollTop = list.scrollHeight;
    return {
      after: {
        dialogScroll: dialog.scrollTop,
        headerTop: header.getBoundingClientRect().top,
        listScroll: list.scrollTop,
        statusTop: status.getBoundingClientRect().top,
      },
      before,
      focused: document.activeElement === entry,
      lifecycleReady: document.querySelector(".lifecycle-renderer")?.dataset.ready,
      modal: dialog.open,
      scope: document.querySelector("#scope").value,
      task: new URL(window.location.href).searchParams.get("task"),
    };
  })()`);
  invariant(
    state.modal,
    "attention-modal-semantics",
    `${context} dialog is not modal`,
  );
  invariant(
    state.focused,
    "attention-deep-link-focus",
    `${context} did not focus ${attentionId}`,
  );
  invariant(
    state.scope === "epic:40" && state.task === "43",
    "attention-deep-link-scope",
    `${context} did not preserve epic:40 scope and task 43 target`,
  );
  invariant(
    state.lifecycleReady === "true",
    "attention-lifecycle-composition",
    `${context} lifecycle canvas is not rendered behind the overlay`,
  );
  invariant(
    state.before.dialogScroll === 0 && state.after.dialogScroll === 0,
    "attention-scroll-ownership",
    `${context} scrolled the dialog instead of its list`,
  );
  invariant(
    state.after.listScroll > 0,
    "attention-scroll-ownership",
    `${context} entry list did not own overflow`,
  );
  invariant(
    state.before.headerTop === state.after.headerTop &&
      state.before.statusTop === state.after.statusTop,
    "attention-fixed-chrome",
    `${context} moved the attention header or status while the list scrolled`,
  );
  await assertAttentionNoHorizontalOverflow(context);
};

const assertLifecycleSettled = async () => {
  await waitFor(
    `document.querySelectorAll("[data-event-sequence]").length === 118 && document.querySelector(".lifecycle-renderer")?.dataset.ready === "true"`,
  );
  const counts = await evaluate(`(() => ({
    events: document.querySelectorAll("[data-event-sequence]").length,
    nodes: document.querySelectorAll("[data-shape-type='flowcraft-node']").length,
  }))()`);
  invariant(
    counts.events === 118,
    "lifecycle-readiness",
    `rendered ${counts.events} ordered events instead of 118`,
  );
  invariant(
    counts.nodes === 8,
    "lifecycle-readiness",
    `rendered ${counts.nodes} lifecycle nodes instead of 8`,
  );
};

const lifecycleGeometry = () =>
  evaluate(`(() => {
    const shell = document.querySelector(".lifecycle-canvas-shell");
    const shellRect = shell.getBoundingClientRect();
    const nodes = [...document.querySelectorAll("[data-shape-type='flowcraft-node']")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        id: node.dataset.shapeId,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    });
    const current = nodes.find(({ id }) => id === "shape:arrange");
    const controls = document.querySelector(".lifecycle-canvas-controls");
    const controlsRect = controls.getBoundingClientRect();
    const history = document.querySelector(".lifecycle-history");
    return {
      controls: {
        buttons: controls.querySelectorAll(":scope > button").length,
        bottom: controlsRect.bottom,
        top: controlsRect.top,
      },
      current,
      history: {
        clientHeight: history.clientHeight,
        scrollHeight: history.scrollHeight,
        tabIndex: history.tabIndex,
      },
      innerHeight: window.innerHeight,
      nodes,
      shell: {
        bottom: shellRect.bottom,
        height: shellRect.height,
        left: shellRect.left,
        right: shellRect.right,
        top: shellRect.top,
        width: shellRect.width,
      },
    };
  })()`);

const assertLifecycleGeometry = async (context) => {
  await delay(180);
  const geometry = await lifecycleGeometry();
  invariant(
    geometry.nodes.length === 8,
    "lifecycle-readable-geometry",
    `${context} rendered ${geometry.nodes.length} lifecycle nodes`,
  );
  const visibleNodes = geometry.nodes.filter(({ width }) => width > 0);
  const narrow = visibleNodes.filter(({ width }) => width < 175.5);
  invariant(
    visibleNodes.length > 0 && narrow.length === 0,
    "lifecycle-readable-geometry",
    `${context} reduced lifecycle nodes below 176px: ${JSON.stringify(narrow)}`,
  );
  invariant(
    geometry.current !== undefined &&
      geometry.current.height >= 163 &&
      geometry.current.left >= geometry.shell.left &&
      geometry.current.right <= geometry.shell.right &&
      geometry.current.top >= Math.max(0, geometry.shell.top) - 0.5 &&
      geometry.current.bottom <=
        Math.min(geometry.innerHeight, geometry.shell.bottom) + 0.5,
    "lifecycle-current-stage-visibility",
    `${context} current stage is outside the visible canvas: ${JSON.stringify(geometry)}`,
  );
  invariant(
    geometry.controls.buttons === 4 &&
      geometry.controls.bottom > 0 &&
      geometry.controls.top < geometry.innerHeight,
    "lifecycle-navigation-reachability",
    `${context} canvas controls are not visible: ${JSON.stringify(geometry.controls)}`,
  );
  invariant(
    geometry.history.tabIndex === 0 &&
      geometry.history.scrollHeight > geometry.history.clientHeight,
    "lifecycle-history-scroll-ownership",
    `${context} event history is not an independent scroll region: ${JSON.stringify(geometry.history)}`,
  );
  return geometry;
};

const exerciseLifecycleNavigation = async (baseUrl) => {
  fixture.reset();
  await setViewport({ height: 844, width: 390 });
  await resetPageEvidence();
  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  let geometry = await assertLifecycleGeometry("lifecycle navigation 390x844");
  invariant(
    geometry.current.width >= 219.5,
    "lifecycle-current-stage-focus",
    `initial current stage width is ${geometry.current.width}px`,
  );

  await command(
    "focus",
    '.lifecycle-canvas-controls button[aria-label="Zoom out"]',
  );
  await press("Enter");
  await press("Enter");
  await delay(180);
  geometry = await lifecycleGeometry();
  invariant(
    geometry.current.width >= 175.5 && geometry.current.width < 177,
    "lifecycle-minimum-readable-scale",
    `zoom out produced ${geometry.current.width}px lifecycle nodes`,
  );

  await command(
    "focus",
    '.lifecycle-canvas-controls button[title="Fit readable graph"]',
  );
  await press("Enter");
  await delay(180);
  geometry = await lifecycleGeometry();
  invariant(
    geometry.nodes
      .filter(({ width }) => width > 0)
      .every(({ width }) => width >= 175.5),
    "lifecycle-minimum-readable-scale",
    `fit reduced lifecycle nodes below 176px: ${JSON.stringify(geometry.nodes)}`,
  );

  await command(
    "focus",
    '.lifecycle-canvas-controls button[title="Focus current stage"]',
  );
  await press("Enter");
  await delay(180);
  geometry = await lifecycleGeometry();
  invariant(
    geometry.current.width >= 219.5 &&
      geometry.current.top >= geometry.shell.top &&
      geometry.current.bottom <= geometry.shell.bottom,
    "lifecycle-current-stage-focus",
    `current-stage control produced ${JSON.stringify(geometry.current)}`,
  );

  const historyScroll = await evaluate(`(() => {
    const history = document.querySelector(".lifecycle-history");
    const pageBefore = window.scrollY;
    history.scrollTop = history.scrollHeight;
    return { pageAfter: window.scrollY, pageBefore, scrollTop: history.scrollTop };
  })()`);
  invariant(
    historyScroll.scrollTop > 0 &&
      historyScroll.pageAfter === historyScroll.pageBefore,
    "lifecycle-history-scroll-ownership",
    `history scroll escaped its panel: ${JSON.stringify(historyScroll)}`,
  );
};

const exerciseLifecycleResize = async (baseUrl) => {
  fixture.reset();
  await setViewport({ height: 900, width: 801 });
  await resetPageEvidence();
  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  let geometry = await assertLifecycleGeometry("lifecycle breakpoint 801x900");
  invariant(
    geometry.shell.height === 560,
    "lifecycle-responsive-resize",
    `801px canvas height is ${geometry.shell.height}px`,
  );

  await setViewport({ height: 900, width: 800 });
  await waitFor(
    `document.querySelector(".lifecycle-canvas-shell")?.getBoundingClientRect().height === 430`,
  );
  geometry = await assertLifecycleGeometry("lifecycle breakpoint 800x900");
  invariant(
    geometry.shell.height === 430,
    "lifecycle-responsive-resize",
    `800px canvas height is ${geometry.shell.height}px`,
  );
  const centerAt800 =
    (geometry.current.top + geometry.current.bottom) / 2 - geometry.shell.top;

  await setViewport({ height: 900, width: 801 });
  await waitFor(
    `document.querySelector(".lifecycle-canvas-shell")?.getBoundingClientRect().height === 560`,
  );
  geometry = await assertLifecycleGeometry("lifecycle live resize 801x900");
  const centerAt801 =
    (geometry.current.top + geometry.current.bottom) / 2 - geometry.shell.top;
  invariant(
    centerAt801 - centerAt800 > 35,
    "lifecycle-responsive-resize",
    `current stage did not recenter after resize: ${centerAt800}px → ${centerAt801}px`,
  );
};

const auditLifecycleGeometryViewport = async (baseUrl, viewport) => {
  fixture.reset();
  await setViewport(viewport);
  await resetPageEvidence();
  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await settleVisuals();
  await assertLifecycleGeometry(
    `lifecycle ${viewport.width}x${viewport.height}`,
  );
  await assertReadOnlySurface("closed");
  await assertNoRuntimeOrNetworkErrors(
    new URL(baseUrl).origin,
    `lifecycle ${viewport.width}x${viewport.height}`,
  );
};

const assertLifecycleTrace = async () => {
  const deadline = Date.now() + 8_000;
  while (fixture.lifecycleTrace().length < 4 && Date.now() < deadline) {
    await delay(20);
  }
  invariant(
    JSON.stringify(fixture.lifecycleTrace().slice(0, 4)) ===
      JSON.stringify([0, 116, 117, 118]),
    "lifecycle-cursor-trace",
    `observed ${fixture.lifecycleTrace().join(" → ")} instead of 0 → 116 → 117 → 118`,
  );
};

const exerciseLifecycleRebase = async (baseUrl) => {
  fixture.reset();
  await setViewport({ height: 1000, width: 1440 });
  await resetPageEvidence();
  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  invariant(
    (await evaluate(
      `document.querySelector(".lifecycle-rebase")?.dataset.state`,
    )) === "current",
    "lifecycle-rebase-availability",
    "rebase was available before the fetched upstream artifact advanced",
  );
  fixture.advanceLifecycleBlueprint();
  await waitFor(
    `document.querySelector(".lifecycle-rebase")?.dataset.state === "available" && document.querySelector(".lifecycle-rebase")?.dataset.available === "true"`,
  );
  const before = await evaluate(`(() => ({
    button: document.querySelector(".lifecycle-rebase-controls button")?.textContent.trim(),
    option: document.querySelector("#lifecycle-rebase-target")?.value,
    summary: document.querySelector(".lifecycle-rebase-summary")?.textContent.trim().replace(/\\s+/g, " "),
  }))()`);
  invariant(
    before.button === "REBASE INSTANCE" &&
      before.option === "arrange" &&
      before.summary === "NEW BLUEPRINT · bbbbbbbbbbbb",
    "lifecycle-rebase-availability",
    `rebase availability is ${JSON.stringify(before)}`,
  );
  await command("focus", ".lifecycle-rebase-controls button");
  await assertFocused(
    ".lifecycle-rebase-controls button",
    "rebase instance activation",
  );
  await press("Enter");
  const deadline = Date.now() + 5_000;
  while (fixture.lifecycleRebases().length < 1 && Date.now() < deadline) {
    await delay(20);
  }
  await waitFor(
    `document.querySelector(".lifecycle-rebase")?.dataset.state === "current" && document.querySelector(".lifecycle-rebase-status")?.textContent === "Rebased to arrange · artifact bbbbbbbbbbbb"`,
  );
  invariant(
    JSON.stringify(fixture.lifecycleRebases()) ===
      JSON.stringify([{ instanceId: "instance-43", targetState: "arrange" }]),
    "lifecycle-rebase-authority",
    `rebase authority received ${JSON.stringify(fixture.lifecycleRebases())}`,
  );
  const after = await evaluate(`(() => ({
    controls: document.querySelectorAll(".lifecycle-rebase-controls button, .lifecycle-rebase-controls select").length,
    summary: document.querySelector(".lifecycle-rebase-summary")?.textContent.trim(),
  }))()`);
  invariant(
    after.controls === 0 && after.summary === "PINNED BLUEPRINT IS CURRENT",
    "lifecycle-rebase-outcome",
    `rebase outcome is ${JSON.stringify(after)}`,
  );
  await assertReadOnlySurface("closed");
};

const assertUnavailableLifecycleReason = async (guard) => {
  const state = await evaluate(`(() => ({
    available: document.querySelector(".lifecycle-rebase")?.dataset.available,
    controls: document.querySelectorAll(".lifecycle-rebase-controls button, .lifecycle-rebase-controls select").length,
    reason: document.querySelector(".lifecycle-rebase-summary")?.textContent.trim().replace(/\\s+/g, " "),
    state: document.querySelector(".lifecycle-rebase")?.dataset.state,
  }))()`);
  invariant(
    state.state === "upstream-target-unavailable" &&
      state.available === "false" &&
      state.controls === 0 &&
      state.reason === "UPSTREAM REBASE TARGET IS UNAVAILABLE",
    guard,
    `unavailable lifecycle target rendered ${JSON.stringify(state)}`,
  );
};

const exerciseUnavailableLifecycleTarget = async (baseUrl, cause) => {
  fixture.reset();
  await setViewport({ height: 1000, width: 1440 });
  await resetPageEvidence();
  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  if (cause === "missing-path") {
    fixture.removeLifecycleBlueprintFromUpstream();
  } else {
    fixture.makeLifecycleSourceUnresolvable();
  }
  await waitFor(
    `document.querySelector(".lifecycle-rebase")?.dataset.state === "upstream-target-unavailable"`,
  );
  await assertUnavailableLifecycleReason(`lifecycle-rebase-${cause}`);
  await command("focus", ".lifecycle-history");
  await press("Tab");
  await assertFocused(
    ".blueprint-editor-actions > button",
    `${cause} unavailable target keyboard continuation`,
  );
  invariant(
    fixture.lifecycleRebases().length === 0,
    `lifecycle-rebase-${cause}`,
    `unavailable target invoked ${JSON.stringify(fixture.lifecycleRebases())}`,
  );
  await assertLifecycleAxe(await axe(), `lifecycle ${cause} unavailable`);
  await assertReadOnlySurface("closed");
  await assertNoRuntimeOrNetworkErrors(
    new URL(baseUrl).origin,
    `lifecycle ${cause} unavailable`,
  );
};

const auditView = async (baseUrl, viewport, view) => {
  fixture.reset();
  await setViewport(viewport);
  await resetPageEvidence();
  const routes = {
    attention: "/?scope=epic%3A40&attention=choice-a",
    board: "/?scope=epic%3A40",
    dependencies: "/?view=dependencies&scope=epic%3A40",
    lifecycle: "/?view=lifecycle&task=43&scope=epic%3A40",
  };
  await open(baseUrl + routes[view]);
  if (view === "board" || view === "attention") {
    await assertPageReady("4 visible records");
  } else if (view === "dependencies") {
    await assertPageReady("4 visible nodes");
  } else {
    await assertLifecycleSettled();
  }
  await settleVisuals();
  const result = await axe();
  if (view === "lifecycle") {
    await assertLifecycleAxe(
      result,
      `${view} ${viewport.width}x${viewport.height}`,
    );
  } else if (view === "board" && viewport.width === 390) {
    await assertMobileBoardAxe(
      result,
      `${view} ${viewport.width}x${viewport.height}`,
    );
  } else {
    assertAxeClean(result, `${view} ${viewport.width}x${viewport.height}`);
  }
  const tree = await assertShellSemantics(view);
  if (view === "board") {
    invariant(
      tree.includes("Kanban board"),
      "computed-accessible-name",
      "board region lacks its computed name",
    );
  }
  if (view === "dependencies") {
    invariant(
      tree.includes("Task dependency graph"),
      "computed-accessible-name",
      "dependency region lacks its computed name",
    );
    assertDependencyGeometry(await dependencyGeometry());
  }
  if (view === "lifecycle") {
    invariant(
      tree.includes("Lifecycle graph") && tree.includes("Instance events"),
      "computed-accessible-name",
      "lifecycle regions lack computed names",
    );
    await assertLifecycleGeometry(
      `${view} ${viewport.width}x${viewport.height}`,
    );
  }
  if (view === "attention") {
    invariant(
      tree.includes("Attention required"),
      "computed-accessible-name",
      "attention dialog lacks its computed name",
    );
    const badge = await evaluate(
      `document.querySelector("#attention-count").textContent`,
    );
    invariant(
      badge === String(fixture.stableAttentionIds.length),
      "attention-badge-count",
      `badge reports ${badge}`,
    );
    await assertAttentionHeadings();
    await assertAttentionNoHorizontalOverflow(
      `attention ${viewport.width}x${viewport.height}`,
    );
  }
  const editorState = view === "lifecycle" ? "closed" : "unavailable";
  await assertEditorControlRoster(editorState);
  await assertReadOnlySurface(editorState);
  await assertNoRuntimeOrNetworkErrors(
    new URL(baseUrl).origin,
    `${view} ${viewport.width}x${viewport.height}`,
  );
};

const assertNotificationRecoveryDetails = async () => {
  const recovery = await snapshotText(
    '.attention-entry[data-attention-id="notification-recovery-a"]',
  );
  const normalized = recovery.toLowerCase();
  invariant(
    normalized.includes("recipient") &&
      normalized.includes("primary operator") &&
      normalized.includes("intended message") &&
      normalized.includes("a sample needs attention.") &&
      normalized.includes("retry notification"),
    "notification-recovery-verification",
    `recovery card lacks its accessible verification details: ${recovery}`,
  );
};

const assertNotificationRecoveryOrder = async () => {
  const order = await evaluate(`(() => {
    const entry = document.querySelector('.attention-entry[data-attention-id="notification-recovery-a"]');
    const details = entry.querySelector('.attention-notification-verification');
    const retry = entry.querySelector('.attention-action');
    return details.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING;
  })()`);
  invariant(
    order !== 0,
    "notification-recovery-before-retry",
    "verification details do not precede Retry notification",
  );
};

const auditIntermediateAttention = async (baseUrl) => {
  for (const width of [679, 690, 740, 800, 801]) {
    fixture.reset();
    await setViewport({ height: 900, width });
    await open(
      `${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40&attention=choice-a`,
    );
    await assertLifecycleSettled();
    await assertAttentionLayout("choice-a", `${width}x900`);
    await settleVisuals();
    assertAxeClean(await axe(), `attention choice-a ${width}x900`);
  }
  await setViewport({ height: 900, width: 740 });
  for (const attentionId of fixture.stableAttentionIds) {
    fixture.reset();
    await open(
      `${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40&attention=${attentionId}`,
    );
    await assertLifecycleSettled();
    await assertAttentionLayout(attentionId, `740x900 ${attentionId}`);
    await settleVisuals();
    assertAxeClean(await axe(), `attention ${attentionId} 740x900`);
  }
  fixture.reset();
  await open(
    `${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40&attention=notification-recovery-a`,
  );
  await assertLifecycleSettled();
  await assertNotificationRecoveryDetails();
  await assertNotificationRecoveryOrder();
  await assertAttentionHeadings();
  const publicAttention = await evaluate(
    `fetch('/api/attention').then((response) => response.text())`,
  );
  invariant(
    !publicAttention.includes("notificationStableId") &&
      !publicAttention.includes("applicationToken") &&
      !publicAttention.includes("userKey"),
    "notification-recovery-public-safety",
    "notification recovery exposed a private provider or stable identifier field",
  );
};

const expectSoleKill = async (name, mutate, check) => {
  await mutate();
  try {
    await check();
  } catch (error) {
    invariant(
      error instanceof QualificationFailure && error.guard === name,
      "mutation-isolation",
      `${name} mutation failed ${error instanceof Error ? error.message : String(error)}`,
    );
    observations.push({ guard: name, soleKill: error.message });
    return;
  }
  throw new QualificationFailure(
    "mutation-isolation",
    `${name} mutation did not fail its named assertion`,
  );
};

const mutationBattery = async (baseUrl) => {
  if (!browserStarted) await open(`${baseUrl}/?scope=epic%3A40`);
  await setViewport({ height: 844, width: 390 });

  fixture.reset();
  await open(`${baseUrl}/?view=dependencies&scope=epic%3A40`);
  await assertPageReady("4 visible nodes");
  await settleVisuals();
  await expectSoleKill(
    "axe-prohibited-aria",
    () =>
      evaluate(
        `document.querySelector("#graph-canvas").setAttribute("aria-label", "Dependency canvas")`,
      ),
    async () =>
      assertAxeRuleAbsent(
        await axe(),
        "aria-prohibited-attr",
        "axe-prohibited-aria",
      ),
  );

  for (const cause of ["missing-path", "unresolvable-source"]) {
    await exerciseUnavailableLifecycleTarget(baseUrl, cause);
    await expectSoleKill(
      `lifecycle-rebase-${cause}`,
      () =>
        evaluate(
          `document.querySelector(".lifecycle-rebase-summary").textContent = "PINNED BLUEPRINT IS CURRENT"`,
        ),
      () => assertUnavailableLifecycleReason(`lifecycle-rebase-${cause}`),
    );
  }
  await setViewport({ height: 844, width: 390 });

  fixture.reset();
  await open(
    `${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40&attention=notification-recovery-a`,
  );
  await assertLifecycleSettled();
  await expectSoleKill(
    "notification-recovery-verification",
    () =>
      evaluate(
        `document.querySelector('.attention-notification-verification dt').textContent = "Destination"`,
      ),
    assertNotificationRecoveryDetails,
  );

  fixture.reset();
  await open(
    `${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40&attention=notification-recovery-a`,
  );
  await assertLifecycleSettled();
  await expectSoleKill(
    "notification-recovery-before-retry",
    () =>
      evaluate(`(() => {
        const entry = document.querySelector('.attention-entry[data-attention-id="notification-recovery-a"]');
        entry.append(entry.querySelector('.attention-notification-verification'));
      })()`),
    assertNotificationRecoveryOrder,
  );

  fixture.reset();
  await open(`${baseUrl}/?scope=epic%3A40&attention=choice-a`);
  await assertPageReady("4 visible records");
  await expectSoleKill(
    "attention-readable-headings",
    () =>
      evaluate(`(() => {
        const entry = document.querySelector('.attention-entry[data-attention-id="choice-a"]');
        entry.querySelector("h3").textContent = "Attention " + entry.dataset.attentionId;
      })()`),
    assertAttentionHeadings,
  );

  fixture.reset();
  await open(`${baseUrl}/?scope=epic%3A40&attention=choice-a`);
  await assertPageReady("4 visible records");
  fixture.currentAttentionKinds.push("sample-new-category");
  await expectSoleKill(
    "attention-category-coverage",
    async () => undefined,
    assertAttentionHeadings,
  );
  fixture.currentAttentionKinds.pop();

  fixture.reset();
  await open(`${baseUrl}/?scope=epic%3A40&attention=choice-a`);
  await assertPageReady("4 visible records");
  await expectSoleKill(
    "attention-no-horizontal-overflow",
    () =>
      evaluate(
        `document.querySelector('.attention-entry[data-attention-id="choice-a"]').style.width = "900px"`,
      ),
    () => assertAttentionNoHorizontalOverflow("mutated attention card"),
  );

  await open(`${baseUrl}/?view=dependencies&scope=epic%3A40`);
  await assertPageReady("4 visible nodes");
  await settleVisuals();
  await expectSoleKill(
    "computed-accessible-name",
    () =>
      evaluate(
        `document.querySelector("#graph-viewport").removeAttribute("aria-label")`,
      ),
    async () => {
      const tree = await snapshotText();
      invariant(
        tree.includes("Task dependency graph"),
        "computed-accessible-name",
        "missing dependency graph name was accepted",
      );
    },
  );

  await open(`${baseUrl}/?view=dependencies&scope=epic%3A40`);
  await assertPageReady("4 visible nodes");
  await settleVisuals();
  await expectSoleKill(
    "scroll-region-focusability",
    () =>
      evaluate(
        `document.querySelector("#graph-viewport").removeAttribute("tabindex")`,
      ),
    async () => {
      const focusability = await evaluate(`(() => {
        const viewport = document.querySelector("#graph-viewport");
        return {
          focusable: viewport.tabIndex === 0,
          overflow: viewport.scrollWidth > viewport.clientWidth,
        };
      })()`);
      invariant(
        !focusability.overflow || focusability.focusable,
        "scroll-region-focusability",
        "an overflowed graph viewport is not directly keyboard focusable",
      );
    },
  );

  await open(`${baseUrl}/?scope=epic%3A40`);
  await assertPageReady("4 visible records");
  await expectSoleKill(
    "board-scroll-region-focusability",
    () =>
      evaluate(`document.querySelector("#board").removeAttribute("tabindex")`),
    async () => {
      const focusability = await evaluate(`(() => {
        const board = document.querySelector("#board");
        return {
          focusable: board.tabIndex === 0,
          overflow: board.scrollWidth > board.clientWidth,
        };
      })()`);
      invariant(
        !focusability.overflow || focusability.focusable,
        "board-scroll-region-focusability",
        "an overflowed board is not directly keyboard focusable",
      );
    },
  );

  await open(`${baseUrl}/?scope=all`);
  await assertPageReady("4 visible records");
  await expectSoleKill(
    "keyboard-shell-control-activation",
    () =>
      evaluate(`document.querySelector("#attention-toggle").addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true)`),
    async () => {
      await evaluate(`document.querySelector("#attention-toggle").focus()`);
      await press("Enter");
      await delay(100);
      invariant(
        await evaluate(
          `document.querySelector("#attention-overlay").open === true`,
        ),
        "keyboard-shell-control-activation",
        "broken attention-toggle activation was accepted",
      );
    },
  );

  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await expectSoleKill(
    "read-only-console",
    () =>
      evaluate(`(() => {
        const button = document.createElement("button");
        button.textContent = "ALTER VIEW";
        document.querySelector(".blueprint-editor-actions").append(button);
      })()`),
    assertReadOnlySurface,
  );

  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await expectSoleKill(
    "editor-control-roster",
    () =>
      evaluate(
        `document.querySelector(".blueprint-editor-actions button").textContent = "EDIT ARTIFACT"`,
      ),
    () => assertEditorControlRoster("closed"),
  );

  fixture.reset();
  fixture.prepareBlueprintEditor();
  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await expectSoleKill(
    "editor-edit-activation",
    () =>
      evaluate(`document.querySelector(".blueprint-editor-actions button").addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true)`),
    async () => {
      await command("focus", ".blueprint-editor-actions button");
      await press("Enter");
      await delay(100);
      invariant(
        fixture.blueprintRequests().loads.length === 1,
        "editor-edit-activation",
        "broken Edit blueprint activation was accepted",
      );
    },
  );

  await beginBlueprintEditing(baseUrl);
  await expectSoleKill(
    "editor-save-activation",
    () =>
      evaluate(`document.querySelector(".blueprint-editor-actions button:first-child").addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true)`),
    async () => {
      await command("focus", ".blueprint-editor-actions button:first-child");
      await press("Enter");
      await delay(100);
      invariant(
        fixture.blueprintRequests().saves.length === 1,
        "editor-save-activation",
        "broken Save artifact activation was accepted",
      );
    },
  );

  await beginBlueprintEditing(baseUrl);
  await expectSoleKill(
    "editor-close-activation",
    () =>
      evaluate(`document.querySelector(".blueprint-editor-actions button:last-child").addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true)`),
    async () => {
      await command("focus", ".blueprint-editor-actions button:last-child");
      await press("Enter");
      await delay(100);
      const state = await editorStatus();
      invariant(
        state.text === "" &&
          JSON.stringify((await editorControlRoster()).direct) ===
            JSON.stringify(editorControlRosters.closed),
        "editor-close-activation",
        `broken Close editor activation was accepted: ${JSON.stringify(state)}`,
      );
    },
  );
  await setViewport({ height: 844, width: 390 });

  await open(`${baseUrl}/?scope=epic%3A40`);
  await assertPageReady("4 visible records");
  await expectSoleKill(
    "keyboard-board-scroll-access",
    () =>
      evaluate(`(() => {
        const board = document.querySelector("#board");
        board.addEventListener("keydown", (event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }, true);
      })()`),
    async () => {
      await evaluate(`(() => {
        const board = document.querySelector("#board");
        board.scrollLeft = 0;
        board.focus();
      })()`);
      await press("ArrowRight");
      await delay(100);
      invariant(
        (await evaluate(`document.querySelector("#board").scrollLeft`)) > 0,
        "keyboard-board-scroll-access",
        "missing board keyboard handler was accepted",
      );
    },
  );

  await open(`${baseUrl}/?view=dependencies&scope=epic%3A40`);
  await assertPageReady("4 visible nodes");
  await expectSoleKill(
    "keyboard-scroll-access",
    () =>
      evaluate(`(() => {
        const viewport = document.querySelector("#graph-viewport");
        viewport.addEventListener("keydown", (event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }, true);
      })()`),
    async () => {
      await evaluate(`document.querySelector("#graph-viewport").focus()`);
      await press("ArrowRight");
      await delay(100);
      const left = await evaluate(
        `document.querySelector("#graph-viewport").scrollLeft`,
      );
      invariant(
        left > 0,
        "keyboard-scroll-access",
        "missing graph keyboard handler was accepted",
      );
    },
  );

  fixture.reset();
  await open(`${baseUrl}/?scope=epic%3A40`);
  await assertPageReady("4 visible records");
  await expectSoleKill(
    "keyboard-authorized-action",
    () =>
      evaluate(`document.querySelector(".epic-lever").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true)`),
    async () => {
      await evaluate(`document.querySelector(".epic-lever").focus()`);
      await press("Enter");
      await delay(100);
      invariant(
        fixture.boardWrites().length === 1,
        "keyboard-authorized-action",
        "broken Enter behavior was accepted",
      );
    },
  );

  await open(`${baseUrl}/?view=dependencies&scope=epic%3A40`);
  await assertPageReady("4 visible nodes");
  await expectSoleKill(
    "dependency-node-height",
    () =>
      evaluate(`document.querySelector(".graph-node").style.height = "127px"`),
    async () => assertDependencyGeometry(await dependencyGeometry()),
  );

  await open(`${baseUrl}/?view=dependencies&scope=epic%3A40`);
  await assertPageReady("4 visible nodes");
  await expectSoleKill(
    "dependency-node-spacing",
    () =>
      evaluate(`(() => {
        const nodes = [...document.querySelectorAll(".graph-node")]
          .filter((node) => node.style.left === "28px")
          .sort((left, right) => Number.parseFloat(left.style.top) - Number.parseFloat(right.style.top));
        nodes[1].style.top = "153px";
      })()`),
    async () => assertDependencyGeometry(await dependencyGeometry()),
  );

  await open(`${baseUrl}/?view=dependencies&scope=epic%3A40`);
  await assertPageReady("4 visible nodes");
  await expectSoleKill(
    "dependency-edge-anchor",
    () =>
      evaluate(`(() => {
        const edge = document.querySelector(".graph-edge");
        edge.setAttribute("d", edge.getAttribute("d").replace(/^M [0-9.]+/, "M 0"));
      })()`),
    async () => assertDependencyGeometry(await dependencyGeometry()),
  );

  await open(`${baseUrl}/?scope=epic%3A40`);
  await assertPageReady("4 visible records");
  await settleVisuals();
  await expectSoleKill(
    "axe-incomplete-disposition",
    () =>
      evaluate(`(() => {
        const style = document.createElement("style");
        style.textContent = '.task-card { position: relative; } .task-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: #77746b; }';
        document.head.append(style);
      })()`),
    async () => assertAxeClean(await axe(), "mutated board decoration"),
  );

  await open(`${baseUrl}/?scope=epic%3A40`);
  await assertPageReady("4 visible records");
  await expectSoleKill(
    "visible-focus-indicator",
    () =>
      evaluate(`(() => {
        document.querySelector("#scope").style.setProperty("outline", "none", "important");
      })()`),
    async () => {
      await evaluate(`document.querySelector(".wordmark").focus()`);
      for (let index = 0; index < 4; index += 1) await press("Tab");
      await assertFocused("#scope", "mutated scope control");
    },
  );

  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await expectSoleKill(
    "lifecycle-readable-geometry",
    () =>
      evaluate(
        `document.querySelector('[data-shape-id="shape:arrange"]').style.scale = "0.5"`,
      ),
    () => assertLifecycleGeometry("mutated lifecycle scale"),
  );

  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await expectSoleKill(
    "lifecycle-current-stage-visibility",
    () =>
      evaluate(
        `document.querySelector('[data-shape-id="shape:arrange"]').style.translate = "1000px 0"`,
      ),
    () => assertLifecycleGeometry("mutated lifecycle focus"),
  );

  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await expectSoleKill(
    "lifecycle-navigation-reachability",
    () =>
      evaluate(
        `document.querySelector('.lifecycle-canvas-controls button:last-child').remove()`,
      ),
    () => assertLifecycleGeometry("mutated lifecycle navigation"),
  );

  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await expectSoleKill(
    "lifecycle-history-scroll-ownership",
    () =>
      evaluate(
        `document.querySelector(".lifecycle-history").removeAttribute("tabindex")`,
      ),
    () => assertLifecycleGeometry("mutated lifecycle history"),
  );

  await setViewport({ height: 900, width: 801 });
  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await expectSoleKill(
    "lifecycle-responsive-resize",
    async () => {
      const height = await evaluate(`(() => {
        const shell = document.querySelector(".lifecycle-canvas-shell");
        shell.style.setProperty("height", "430px", "important");
        return shell.getBoundingClientRect().height;
      })()`);
      invariant(
        height === 430,
        "mutation-application",
        `responsive mutation produced ${height}px`,
      );
    },
    async () => {
      const geometry = await lifecycleGeometry();
      invariant(
        geometry.shell.height === 560,
        "lifecycle-responsive-resize",
        `mutated 801px canvas height is ${geometry.shell.height}px`,
      );
    },
  );

  await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
  await assertLifecycleSettled();
  await settleVisuals();
  await expectSoleKill(
    "lifecycle-node-contrast",
    () =>
      evaluate(`(() => {
        const target = ".lifecycle-canvas-shell .tl-html-container > div > div:nth-child(n + 3) > div:first-child";
        for (const element of document.querySelectorAll(target)) {
          element.style.setProperty("color", "#9ca3af", "important");
        }
      })()`),
    async () => {
      const target =
        ".lifecycle-canvas-shell .tl-html-container > div > div:nth-child(n + 3) > div:first-child";
      assertComputedContrast(
        await computedContrastTargets([target]),
        "lifecycle-node-contrast",
      );
    },
  );

  await expectSoleKill(
    "lifecycle-control-contrast",
    () =>
      evaluate(`(() => {
        const button = document.querySelector('.lifecycle-canvas-controls button[aria-label="Zoom out"]');
        button.style.setProperty("color", "#77746b", "important");
        button.style.setProperty("background", "#77746b", "important");
      })()`),
    async () => {
      assertComputedContrast(
        await computedContrastTargets([
          '.lifecycle-canvas-controls button[aria-label="Zoom out"]',
        ]),
        "lifecycle-control-contrast",
      );
    },
  );
};

const main = async () => {
  fixture.server.listen(0, "127.0.0.1");
  await once(fixture.server, "listening");
  const address = fixture.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("qualification fixture did not bind an IP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const viewports = [
    { height: 1000, width: 1440 },
    { height: 844, width: 390 },
  ];

  invariant(
    ["all", "baseline", "mutations"].includes(phase),
    "qualification-phase",
    `unknown phase ${phase}`,
  );
  if (phase !== "mutations") {
    await exerciseShellControls(baseUrl);
    for (const viewport of viewports) {
      for (const view of ["board", "dependencies", "lifecycle", "attention"]) {
        await auditView(baseUrl, viewport, view);
      }
    }
    for (const viewport of [
      { height: 577, width: 1280 },
      { height: 720, width: 1280 },
    ]) {
      await auditLifecycleGeometryViewport(baseUrl, viewport);
    }
    await exerciseLifecycleNavigation(baseUrl);
    await exerciseLifecycleResize(baseUrl);
    await setViewport({ height: 844, width: 390 });
    await assertBoardKeyboard(baseUrl);
    await assertSafeEpicControls(baseUrl);
    await assertDependencyKeyboard(baseUrl);
    await exerciseAttentionActions(baseUrl);
    await auditIntermediateAttention(baseUrl);

    fixture.reset();
    await setViewport({ height: 1000, width: 1440 });
    await open(`${baseUrl}/?view=lifecycle&task=43&scope=epic%3A40`);
    await assertLifecycleSettled();
    await assertLifecycleTrace();
    await exerciseUnavailableLifecycleTarget(baseUrl, "missing-path");
    await exerciseUnavailableLifecycleTarget(baseUrl, "unresolvable-source");
    await exerciseLifecycleRebase(baseUrl);
    await exerciseBlueprintEditor(baseUrl);
    await open(`${baseUrl}/?scope=epic%3A40`);
  }

  if (phase !== "baseline") await mutationBattery(baseUrl);

  const soleKills = observations.filter(
    ({ soleKill }) => soleKill !== undefined,
  );
  process.stdout.write(
    JSON.stringify(
      {
        axe: "zero violations; attention focus audits have zero incomplete results; lifecycle overlap and mobile board clipping use explicit computed-contrast dispositions",
        incompleteDispositions: observations.filter(
          ({ disposition }) => disposition !== undefined,
        ),
        mutationGuards: soleKills.map(({ guard }) => guard),
        networkAndRuntime: observations.filter(
          ({ consoleMessages }) => consoleMessages !== undefined,
        ),
        stableAttentionIds: fixture.stableAttentionIds,
        status: "passed",
        viewports: [
          "1440x1000",
          "1280x577",
          "1280x720",
          "390x844",
          "800/801x900 live resize",
          "679/690/740/800/801x900 attention",
        ],
      },
      null,
      2,
    ) + "\n",
  );
};

try {
  await main();
} finally {
  try {
    if (browserStarted) {
      await command("close").catch(() => undefined);
    }
    if (fixture.server.listening) {
      await new Promise((resolve, reject) =>
        fixture.server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  } finally {
    await fixture.cleanup();
  }
}
