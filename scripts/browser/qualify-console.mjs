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
const fixture = createConsoleQualificationFixture();
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
        inLifecycleNode: element.closest("[data-shape-id^='shape:'] .tl-html-container") !== null,
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
    `${context} has ${violations.length} violation(s)`,
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
  for (const item of computed) {
    invariant(
      item.inLifecycleNode,
      "axe-incomplete-disposition",
      `${item.target} is outside the bounded lifecycle-node disposition`,
    );
  }
  assertComputedContrast(computed, "lifecycle-node-contrast");
  observations.push({
    context,
    disposition:
      "axe cannot determine lifecycle-node backgrounds because tldraw layers overlap; computed foreground/background contrast is checked for every incomplete target",
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

const assertReadOnlySurface = async () => {
  const result = await evaluate(`(() => {
    const tabbableMutation = [...document.querySelectorAll(
      "#board button, #board input, #board textarea, #dependency-graph button, #dependency-graph input, #dependency-graph textarea, #lifecycle-view button, #lifecycle-view input, #lifecycle-view textarea, [contenteditable='true']",
    )].filter((element) => {
      if (
        element.disabled ||
        element.tabIndex < 0 ||
        element.matches(".epic-lever, .blueprint-editor-actions button")
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
    `${baseUrl}/?view=lifecycle&scope=task%3A43&attention=${encodeURIComponent(attentionId)}`,
  );
  await waitFor(
    `document.querySelector('.attention-entry[data-attention-id=${JSON.stringify(attentionId)}]')?.dataset.focused === "true"`,
  );
};

const exerciseAttentionActions = async (baseUrl) => {
  await openAttentionEntry(baseUrl, "choice-a");
  await press("Tab");
  await assertFocused(
    '.attention-entry[data-attention-id="choice-a"] input[value="compact"]',
    "escalation option",
  );
  await press("Space");
  await press("Tab");
  await assertFocused(
    '.attention-entry[data-attention-id="choice-a"] .attention-action',
    "escalation answer",
  );
  await press("Enter");
  let action = await waitForAction();
  invariant(
    action.action.contract.kind === "escalation.answer" &&
      action.answers.layout === "compact",
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
    '.attention-entry[data-attention-id="input-a"] input[value="compact"]',
    "user-input option",
  );
  await press("Space");
  await press("Tab");
  await assertFocused(
    '.attention-entry[data-attention-id="input-a"] .attention-action',
    "user-input response",
  );
  await press("Enter");
  action = await waitForAction();
  invariant(
    action.action.contract.kind === "t3.user-input.respond" &&
      action.answers.placement === "compact",
    "keyboard-authorized-action",
    "user-input response did not preserve the offered target and value",
  );

  for (const attentionId of ["stale-a", "uat-a"]) {
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
    state.scope === "task:43",
    "attention-deep-link-scope",
    `${context} did not preserve task:43 scope`,
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
};

const assertLifecycleSettled = async () => {
  await waitFor(
    `document.querySelectorAll("[data-event-sequence]").length === 5 && document.querySelector(".lifecycle-renderer")?.dataset.ready === "true"`,
  );
  const counts = await evaluate(`(() => ({
    events: document.querySelectorAll("[data-event-sequence]").length,
    nodes: document.querySelectorAll("[data-shape-type='flowcraft-node'], [data-shape-id^='shape:']").length,
  }))()`);
  invariant(
    counts.events === 5,
    "lifecycle-readiness",
    `rendered ${counts.events} ordered events instead of 5`,
  );
  invariant(
    counts.nodes >= 2,
    "lifecycle-readiness",
    `rendered ${counts.nodes} lifecycle nodes instead of at least 2`,
  );
};

const assertLifecycleTrace = async () => {
  const deadline = Date.now() + 8_000;
  while (fixture.lifecycleTrace().length < 4 && Date.now() < deadline) {
    await delay(20);
  }
  invariant(
    JSON.stringify(fixture.lifecycleTrace().slice(0, 4)) ===
      JSON.stringify([0, 3, 4, 5]),
    "lifecycle-cursor-trace",
    `observed ${fixture.lifecycleTrace().join(" → ")} instead of 0 → 3 → 4 → 5`,
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
    lifecycle: "/?view=lifecycle&scope=task%3A43",
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
    invariant(badge === "5", "attention-badge-count", `badge reports ${badge}`);
  }
  await assertReadOnlySurface();
  await assertNoRuntimeOrNetworkErrors(
    new URL(baseUrl).origin,
    `${view} ${viewport.width}x${viewport.height}`,
  );
};

const auditIntermediateAttention = async (baseUrl) => {
  for (const width of [679, 690, 740, 800, 801]) {
    fixture.reset();
    await setViewport({ height: 900, width });
    await open(`${baseUrl}/?view=lifecycle&scope=task%3A43&attention=choice-a`);
    await assertLifecycleSettled();
    await assertAttentionLayout("choice-a", `${width}x900`);
    await settleVisuals();
    assertAxeClean(await axe(), `attention choice-a ${width}x900`);
  }
  await setViewport({ height: 900, width: 740 });
  for (const attentionId of fixture.stableAttentionIds) {
    fixture.reset();
    await open(
      `${baseUrl}/?view=lifecycle&scope=task%3A43&attention=${attentionId}`,
    );
    await assertLifecycleSettled();
    await assertAttentionLayout(attentionId, `740x900 ${attentionId}`);
    await settleVisuals();
    assertAxeClean(await axe(), `attention ${attentionId} 740x900`);
  }
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

  await open(`${baseUrl}/?view=lifecycle&scope=task%3A43`);
  await assertLifecycleSettled();
  await expectSoleKill(
    "read-only-console",
    () =>
      evaluate(`(() => {
        const button = document.createElement("button");
        button.textContent = "ALTER VIEW";
        document.querySelector("#lifecycle-view").append(button);
      })()`),
    assertReadOnlySurface,
  );

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

  await open(`${baseUrl}/?view=lifecycle&scope=task%3A43`);
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
    await setViewport({ height: 844, width: 390 });
    await assertBoardKeyboard(baseUrl);
    await assertDependencyKeyboard(baseUrl);
    await exerciseAttentionActions(baseUrl);
    await auditIntermediateAttention(baseUrl);

    fixture.reset();
    await setViewport({ height: 1000, width: 1440 });
    await open(`${baseUrl}/?view=lifecycle&scope=task%3A43`);
    await assertLifecycleSettled();
    await assertLifecycleTrace();
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
        viewports: ["1440x1000", "390x844", "679/690/740/800/801x900"],
      },
      null,
      2,
    ) + "\n",
  );
};

try {
  await main();
} finally {
  if (browserStarted) {
    await command("close").catch(() => undefined);
  }
  fixture.server.close();
}
