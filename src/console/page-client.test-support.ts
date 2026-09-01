// ---
// relationships:
//   validates: heddle
// ---

import { runInNewContext } from "node:vm";
import { URL } from "node:url";

import { expect, vi } from "vitest";

import { consoleClient } from "./page.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, (event?: unknown) => void>();
  checked = false;
  className = "";
  clientWidth = 320;
  disabled = false;
  draggable = false;
  focusCount = 0;
  hidden = false;
  href = "";
  name = "";
  open = false;
  mutationCount = 0;
  replaceCount = 0;
  scrollLeft = 0;
  scrollWidth = 800;
  textContentWriteCount = 0;
  type = "";
  value = "";
  private content = "";
  parentElement?: FakeElement;

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.content;
  }

  set textContent(value: string) {
    this.content = value;
    this.textContentWriteCount += 1;
  }

  addEventListener(name: string, listener: (event?: unknown) => void): void {
    this.listeners.set(name, listener);
  }

  dispatch(name: string, event?: unknown): void {
    this.listeners.get(name)?.(event);
  }

  close(): void {
    this.open = false;
    this.dispatch("close");
  }

  focus(): void {
    this.focusCount += 1;
    this.dataset.focusedByTest = "true";
  }

  scrollIntoViewCount = 0;

  scrollIntoView(): void {
    this.scrollIntoViewCount += 1;
  }

  showModal(): void {
    this.open = true;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) child.parentElement = this;
    this.children.push(...children);
  }

  insertBefore(child: FakeElement, reference: FakeElement | null): void {
    child.parentElement?.removeChild(child);
    const index =
      reference === null
        ? this.children.length
        : this.children.indexOf(reference);
    child.parentElement = this;
    this.children.splice(index, 0, child);
    this.mutationCount += 1;
  }

  querySelector(selector: string): FakeElement | undefined {
    const className = selector.startsWith(".") ? selector.slice(1) : undefined;
    for (const child of this.children) {
      if (child.className === className) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return undefined;
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = undefined;
    this.mutationCount += 1;
  }

  replaceChild(next: FakeElement, current: FakeElement): void {
    const index = this.children.indexOf(current);
    if (index < 0) throw new Error("child does not belong to container");
    current.parentElement = undefined;
    next.parentElement = this;
    this.children.splice(index, 1, next);
    this.mutationCount += 1;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.replaceCount += 1;
    this.mutationCount += 1;
    this.scrollLeft = 0;
    for (const child of this.children) child.parentElement = undefined;
    for (const child of children) child.parentElement = this;
    this.children.splice(0, this.children.length, ...children);
  }
}

class FakeOption extends FakeElement {
  constructor(
    textContent: string,
    readonly value: string,
  ) {
    super("option");
    this.textContent = textContent;
  }
}

class FakeSelect extends FakeElement {
  readonly options: FakeOption[] = [];
  private optionIndex = -1;

  constructor() {
    super("select");
  }

  add(option: FakeOption): void {
    this.options.push(option);
  }

  override replaceChildren(...children: FakeOption[]): void {
    super.replaceChildren(...children);
    this.options.splice(0, this.options.length, ...children);
    this.optionIndex = children.length === 0 ? -1 : 0;
  }

  get selectedIndex(): number {
    return this.optionIndex;
  }

  set selectedIndex(value: number) {
    this.optionIndex = value;
  }

  get value(): string {
    return this.options[this.optionIndex]?.value ?? "";
  }

  set value(value: string) {
    this.optionIndex = this.options.findIndex(
      (option) => option.value === value,
    );
  }
}

export interface BrowserResponse {
  json(): Promise<unknown>;
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface BrowserRequestOptions {
  body?: unknown;
  cache?: string;
  headers?: Record<string, string>;
  method?: string;
}

export interface GraphFixture {
  edges: Array<{ from: number; to: number; trace: boolean }>;
  nodes: Array<{
    id: number;
    layer: number;
    priority: string;
    row: number;
    status: string;
    title: string;
    treatment: string;
  }>;
}

export const response = (
  body: unknown,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): BrowserResponse => ({
  json: async () => body,
  ok,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const isBrowserResponse = (value: unknown): value is BrowserResponse =>
  typeof value === "object" &&
  value !== null &&
  "ok" in value &&
  "status" in value &&
  "json" in value &&
  "text" in value;

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

export const rootTask = {
  blocked: false,
  dependencies: [],
  id: 10,
  priority: "medium",
  status: "in-progress",
  tags: ["type:epic"],
  title: "Example group",
};

export const childTask = {
  blocked: false,
  dependencies: [],
  id: 11,
  parent: 10,
  priority: "medium",
  status: "in-progress",
  tags: [],
  title: "Example item",
};

export const stagedTask = {
  ...childTask,
  dwellMilliseconds: 59_000,
  stageEnteredAt: 17_941_000,
  stageId: "prepare",
};

export const deferredTask = {
  ...childTask,
  deferral: {
    activeSessions: 2,
    limit: 2,
    reason: "work-in-progress-limit",
  },
  instanceId: "instance-11",
  status: "todo",
};

export const providerDeferredTask = {
  ...childTask,
  deferral: {
    limit: 80,
    provider: "provider-a",
    reason: "provider-usage-window",
    retryAt: 18_010_000,
    used: 80,
  },
  instanceId: "instance-11",
  status: "todo",
};

export const projection = (tasks: unknown[]) => ({
  columns: [{ status: "in-progress", tasks }],
});

export const clientHarness = async (
  initialTasks = [rootTask, childTask],
  initialUrl = "http://console.test/?scope=all",
  initialGraph?: GraphFixture,
  initialLifecycle?: unknown,
  initialAttention: unknown[] = [],
) => {
  const board = new FakeElement("div");
  const graph = new FakeElement("section");
  const graphViewport = new FakeElement("div");
  const graphCanvas = new FakeElement("div");
  const lifecycle = new FakeElement("section");
  const lifecycleTask = new FakeElement("p");
  const lifecycleEmpty = new FakeElement("p");
  lifecycleEmpty.hidden = true;
  lifecycleEmpty.textContent =
    "No lifecycle instance exists for this task. It has not started yet.";
  const viewEyebrow = new FakeElement("p");
  const viewTitle = new FakeElement("h1");
  const boardViewLink = new FakeElement("a");
  const dependenciesViewLink = new FakeElement("a");
  const scope = new FakeSelect();
  scope.replaceChildren(new FakeOption("All work", "all"));
  const status = new FakeElement("p");
  const attention = new FakeElement("span");
  const attentionToggle = new FakeElement("button");
  const attentionOverlay = new FakeElement("dialog");
  const attentionClose = new FakeElement("button");
  const attentionStatus = new FakeElement("p");
  const attentionList = new FakeElement("div");
  const liveBoardMark = new FakeElement("span");
  const liveBoardStatus = new FakeElement("span");
  let boardTasks = initialTasks;
  let attentionEntries = initialAttention;
  let heldBoardResponse: Promise<BrowserResponse> | undefined;
  let graphFixture = initialGraph;
  let locationHref = initialUrl;
  const windowListeners = new Map<string, () => void>();
  const graphResponses = new Map<string, Promise<BrowserResponse>>();
  const graphRequests: string[] = [];
  const projectionResponses = new Map<string, Promise<BrowserResponse>>();
  const projectionRequests: string[] = [];
  const lifecycleResponses: BrowserResponse[] =
    initialLifecycle === undefined
      ? []
      : [
          isBrowserResponse(initialLifecycle)
            ? initialLifecycle
            : response(initialLifecycle),
        ];
  const lifecycleRequests: string[] = [];
  const lifecycleSnapshots: unknown[] = [];
  const attentionRequests: Array<{
    input: string;
    options?: BrowserRequestOptions;
  }> = [];
  const timeouts = new Map<number, { callback: () => void; due: number }>();
  let clock = 18_000_000;
  let nextTimeout = 0;

  const fetch = async (
    input: string,
    options?: BrowserRequestOptions,
  ): Promise<BrowserResponse> => {
    if (input === "/api/board") {
      if (heldBoardResponse !== undefined) return heldBoardResponse;
      return response({ tasks: boardTasks });
    }
    if (input === "/api/attention") return response(attentionEntries);
    if (input.startsWith("/api/attention/") && options?.method === "POST") {
      attentionRequests.push({ input, options });
      return response(null, { status: 204 });
    }
    if (input.startsWith("/api/lifecycle?")) {
      lifecycleRequests.push(input);
      const queued = lifecycleResponses.shift();
      if (queued !== undefined) return queued;
      return response({
        blueprint: {
          blobHash: "a".repeat(40),
          edges: [],
          id: "parcel-preparation",
          nodes: [{ id: "label", uses: "wait" }],
          path: "blueprints/parcel-preparation.json",
        },
        currentStageIds: ["label"],
        events: [],
        instanceId: "instance-11",
        nextSequence: 0,
        status: "awaiting",
        taskId: 11,
      });
    }
    if (input.startsWith("/api/dependency-graph?")) {
      const requestedScope = new URL(input, locationHref).searchParams.get(
        "scope",
      );
      graphRequests.push(requestedScope!);
      const heldResponse = graphResponses.get(requestedScope!);
      if (heldResponse !== undefined) return heldResponse;
      const graph = graphFixture ?? {
        edges: [{ from: 10, to: 11, trace: true }],
        nodes: [
          {
            id: 10,
            layer: 0,
            priority: "medium",
            row: 0,
            status: "in-progress",
            title: "Example group",
            treatment: "attention",
          },
          {
            id: 11,
            layer: 1,
            priority: "medium",
            row: 0,
            status: "todo",
            title: "Example item",
            treatment: "blocked",
          },
        ],
      };
      if (requestedScope === "task:11") {
        return response({ edges: [], nodes: [graph.nodes[1]] });
      }
      return response(graph);
    }
    if (input.startsWith("/api/projection?")) {
      const requestedScope = new URL(input, locationHref).searchParams.get(
        "scope",
      )!;
      projectionRequests.push(requestedScope);
      const heldResponse = projectionResponses.get(requestedScope);
      if (heldResponse !== undefined) return heldResponse;
      const scopedTasks =
        requestedScope === "all"
          ? boardTasks
          : requestedScope.startsWith("epic:")
            ? boardTasks.filter(
                (task) =>
                  task.id === Number(requestedScope.slice("epic:".length)) ||
                  task.parent === Number(requestedScope.slice("epic:".length)),
              )
            : boardTasks.filter(
                (task) =>
                  task.id === Number(requestedScope.slice("task:".length)),
              );
      if (requestedScope.startsWith("task:"))
        return response(projection(scopedTasks));
      if (requestedScope === "epic:10") {
        return response(projection(scopedTasks));
      }
      if (requestedScope === "all") {
        return response(projection(scopedTasks));
      }
      return response(`scope ${requestedScope} is invalid`, {
        ok: false,
        status: 400,
      });
    }
    throw new Error(`unexpected request ${input}`);
  };

  const document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      new FakeElement(tagName),
    querySelector: (selector: string) => {
      if (selector === "#board") return board;
      if (selector === "#scope") return scope;
      if (selector === "#console-status") return status;
      if (selector === "#attention-count") return attention;
      if (selector === "#attention-toggle") return attentionToggle;
      if (selector === "#attention-overlay") return attentionOverlay;
      if (selector === "#attention-close") return attentionClose;
      if (selector === "#attention-status") return attentionStatus;
      if (selector === "#attention-list") return attentionList;
      if (selector === "#dependency-graph") return graph;
      if (selector === "#graph-viewport") return graphViewport;
      if (selector === "#graph-canvas") return graphCanvas;
      if (selector === "#lifecycle-view") return lifecycle;
      if (selector === "#lifecycle-task") return lifecycleTask;
      if (selector === "#lifecycle-empty") return lifecycleEmpty;
      if (selector === "#view-eyebrow") return viewEyebrow;
      if (selector === "#view-title") return viewTitle;
      if (selector === "#board-view-link") return boardViewLink;
      if (selector === "#dependencies-view-link") return dependenciesViewLink;
      if (selector === "#live-board-mark") return liveBoardMark;
      if (selector === "#live-board-status") return liveBoardStatus;
      throw new Error(`unexpected selector ${selector}`);
    },
    querySelectorAll: (selector: string) => {
      if (selector !== "[data-stage-entered-at]") return [];
      const visit = (element: FakeElement): FakeElement[] => [
        element,
        ...element.children.flatMap(visit),
      ];
      return visit(board).filter(
        ({ dataset }) => dataset.stageEnteredAt !== undefined,
      );
    },
  };

  class HarnessDate extends Date {
    static override now(): number {
      return clock;
    }
  }

  const window = {
    addEventListener: (name: string, listener: () => void) => {
      windowListeners.set(name, listener);
    },
    history: {
      pushState: (_state: object, _unused: string, url: URL) => {
        locationHref = url.href;
      },
    },
    location: {
      get href() {
        return locationHref;
      },
    },
    clearTimeout: (id: number) => {
      timeouts.delete(id);
    },
    heddleLifecycleViewer: {
      append: (value: unknown) => lifecycleSnapshots.push(value),
      clear: () => lifecycleSnapshots.splice(0),
      replace: (value: unknown) => lifecycleSnapshots.push(value),
    },
    setInterval: () => 0,
    setTimeout: (callback: () => void, delay = 0) => {
      const id = ++nextTimeout;
      timeouts.set(id, { callback, due: clock + delay });
      return id;
    },
  };

  runInNewContext(consoleClient, {
    Date: HarnessDate,
    Error,
    JSON,
    Math,
    Number,
    Option: FakeOption,
    Promise,
    String,
    URL,
    document,
    encodeURIComponent,
    fetch,
    window,
  });

  await vi.waitFor(() => expect(status.textContent).not.toBe("Loading board…"));

  const visit = (element: FakeElement): FakeElement[] => [
    element,
    ...element.children.flatMap(visit),
  ];
  const cardIds = (): string[] => {
    return visit(board)
      .filter(({ tagName }) => tagName === "article")
      .map(({ dataset }) => dataset.taskId!);
  };
  const cardElements = (): FakeElement[] =>
    visit(board).filter(
      ({ tagName, dataset }) =>
        tagName === "article" && dataset.taskId !== undefined,
    );
  const cardStacks = (): FakeElement[] =>
    visit(board).filter(({ className }) => className === "card-stack");

  return {
    board,
    boardViewLink,
    cardIds,
    cardElements,
    cardStacks,
    dependenciesViewLink,
    attention,
    attentionElements: () => visit(attentionList),
    attentionList,
    attentionOverlay,
    attentionRequests,
    attentionStatus,
    elementsByClass: (className: string) =>
      visit(board).filter((element) => element.className === className),
    holdProjection: (name: string, held: Promise<BrowserResponse>) => {
      projectionResponses.set(name, held);
    },
    projectionRequests,
    holdBoard: (held: Promise<BrowserResponse>) => {
      heldBoardResponse = held;
    },
    releaseBoard: () => {
      heldBoardResponse = undefined;
    },
    holdGraph: (name: string, held: Promise<BrowserResponse>) => {
      graphResponses.set(name, held);
    },
    graph,
    graphCanvas,
    graphViewport,
    graphRequests,
    lifecycle,
    lifecycleEmpty,
    lifecycleTask,
    lifecycleSnapshots,
    lifecycleRequests,
    liveBoardMark,
    liveBoardStatus,
    location: () => locationHref,
    navigate: (name: string) => {
      locationHref = `http://console.test/?scope=${encodeURIComponent(name)}`;
      windowListeners.get("popstate")!();
    },
    navigateUrl: (url: string) => {
      locationHref = url;
      windowListeners.get("popstate")!();
    },
    queueLifecycle: (body: unknown) => {
      lifecycleResponses.push(response(body));
    },
    replaceGraph: (value: GraphFixture) => {
      graphFixture = value;
    },
    replaceAttention: (value: unknown[]) => {
      attentionEntries = value;
    },
    replaceTasks: (value: typeof initialTasks) => {
      boardTasks = value;
    },
    runNextTimeout: () => {
      const next = [...timeouts.entries()].sort(
        ([leftId, left], [rightId, right]) =>
          left.due - right.due || leftId - rightId,
      )[0];
      if (next === undefined) throw new Error("no timeout is scheduled");
      const [id, { callback, due }] = next;
      timeouts.delete(id);
      clock = due;
      callback();
    },
    scope,
    status,
    viewEyebrow,
    viewTitle,
  };
};
