// ---
// relationships:
//   validates: heddle
// ---

import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { consoleClient } from "./page.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, () => void>();
  className = "";
  disabled = false;
  draggable = false;
  hidden = false;
  href = "";
  textContent = "";
  type = "";

  constructor(readonly tagName: string) {}

  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }

  dispatch(name: string): void {
    this.listeners.get(name)?.();
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
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
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

interface BrowserResponse {
  json(): Promise<unknown>;
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

const response = (
  body: unknown,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): BrowserResponse => ({
  json: async () => body,
  ok,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const rootTask = {
  blocked: false,
  dependencies: [],
  id: 10,
  priority: "medium",
  status: "in-progress",
  tags: ["type:epic"],
  title: "Example group",
};

const childTask = {
  blocked: false,
  dependencies: [],
  id: 11,
  parent: 10,
  priority: "medium",
  status: "in-progress",
  tags: [],
  title: "Example item",
};

const deferredTask = {
  ...childTask,
  deferral: {
    activeSessions: 2,
    limit: 2,
    reason: "work-in-progress-limit",
  },
  instanceId: "instance-11",
  status: "todo",
};

const providerDeferredTask = {
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

const projection = (tasks: unknown[]) => ({
  columns: [{ status: "in-progress", tasks }],
});

const clientHarness = async (
  initialTasks = [rootTask, childTask],
  initialUrl = "http://console.test/?scope=all",
) => {
  const board = new FakeElement("div");
  const graph = new FakeElement("section");
  const graphCanvas = new FakeElement("div");
  const lifecycle = new FakeElement("section");
  const lifecycleTask = new FakeElement("p");
  const viewEyebrow = new FakeElement("p");
  const viewTitle = new FakeElement("h1");
  const boardViewLink = new FakeElement("a");
  const dependenciesViewLink = new FakeElement("a");
  const scope = new FakeSelect();
  scope.replaceChildren(new FakeOption("All work", "all"));
  const status = new FakeElement("p");
  const attention = new FakeElement("span");
  let locationHref = initialUrl;
  const windowListeners = new Map<string, () => void>();
  const graphResponses = new Map<string, Promise<BrowserResponse>>();
  const projectionResponses = new Map<string, Promise<BrowserResponse>>();

  const fetch = async (input: string): Promise<BrowserResponse> => {
    if (input === "/api/board") {
      return response({ tasks: initialTasks });
    }
    if (input === "/api/attention") return response([]);
    if (input.startsWith("/api/dependency-graph?")) {
      const requestedScope = new URL(input, locationHref).searchParams.get(
        "scope",
      );
      const heldResponse = graphResponses.get(requestedScope!);
      if (heldResponse !== undefined) return heldResponse;
      const graph = {
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
      const heldResponse = projectionResponses.get(requestedScope);
      if (heldResponse !== undefined) return heldResponse;
      if (requestedScope === "task:11")
        return response(projection([childTask]));
      if (requestedScope === "epic:10") {
        return response(projection([rootTask, childTask]));
      }
      if (requestedScope === "all") {
        return response(projection(initialTasks));
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
      if (selector === "#dependency-graph") return graph;
      if (selector === "#graph-canvas") return graphCanvas;
      if (selector === "#lifecycle-view") return lifecycle;
      if (selector === "#lifecycle-task") return lifecycleTask;
      if (selector === "#view-eyebrow") return viewEyebrow;
      if (selector === "#view-title") return viewTitle;
      if (selector === "#board-view-link") return boardViewLink;
      if (selector === "#dependencies-view-link") return dependenciesViewLink;
      throw new Error(`unexpected selector ${selector}`);
    },
    querySelectorAll: () => [],
  };

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
    setInterval: () => 0,
  };

  runInNewContext(consoleClient, {
    Date,
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

  return {
    board,
    boardViewLink,
    cardIds,
    dependenciesViewLink,
    elementsByClass: (className: string) =>
      visit(board).filter((element) => element.className === className),
    holdProjection: (name: string, held: Promise<BrowserResponse>) => {
      projectionResponses.set(name, held);
    },
    holdGraph: (name: string, held: Promise<BrowserResponse>) => {
      graphResponses.set(name, held);
    },
    graph,
    graphCanvas,
    lifecycle,
    lifecycleTask,
    location: () => locationHref,
    navigate: (name: string) => {
      locationHref = `http://console.test/?scope=${encodeURIComponent(name)}`;
      windowListeners.get("popstate")!();
    },
    navigateUrl: (url: string) => {
      locationHref = url;
      windowListeners.get("popstate")!();
    },
    scope,
    status,
    viewEyebrow,
    viewTitle,
  };
};

describe("console client request ownership", () => {
  it("renders traced graph nodes with task-scoped lifecycle links", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=dependencies&scope=epic%3A10",
    );

    expect(harness.board.hidden).toBe(true);
    expect(harness.graph.hidden).toBe(false);
    expect(harness.viewEyebrow.textContent).toBe("DEPENDENCY GRAPH");
    expect(harness.status.textContent).toBe(
      "2 visible nodes · 1 dependency edges",
    );
    const links = harness.graphCanvas.children.filter(
      ({ tagName }) => tagName === "a",
    );
    expect(links.map(({ dataset }) => dataset.treatment)).toEqual([
      "attention",
      "blocked",
    ]);
    expect(links[1]?.href).toBe("/?view=lifecycle&scope=task%3A11");
    expect(links[1]?.getAttribute("aria-label")).toContain(
      "Open lifecycle view",
    );
    const edge = harness.graphCanvas.children[0]?.children.find(
      (element) =>
        element.tagName === "path" &&
        element.getAttribute("data-trace") !== null,
    );
    expect(edge?.dataset.trace).toBeUndefined();
    expect(edge?.getAttribute("data-trace")).toBe("true");
    expect(harness.dependenciesViewLink.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(harness.boardViewLink.href).toBe("/?scope=epic%3A10");
    expect(harness.dependenciesViewLink.href).toBe(
      "/?view=dependencies&scope=epic%3A10",
    );
    expect(links.map(({ style }) => [style.left, style.top])).toEqual([
      ["28px", "28px"],
      ["338px", "28px"],
    ]);

    harness.scope.value = "task:11";
    harness.scope.dispatch("change");
    await vi.waitFor(() =>
      expect(harness.status.textContent).toBe(
        "1 visible nodes · 0 dependency edges",
      ),
    );
    expect(harness.location()).toBe(
      "http://console.test/?view=dependencies&scope=task%3A11",
    );
  });

  it("opens the task-scoped lifecycle route selected by a graph node", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=lifecycle&scope=task%3A11",
    );

    expect(harness.lifecycle.hidden).toBe(false);
    expect(harness.lifecycleTask.textContent).toBe("Task #11 · Example item");
    expect(harness.status.textContent).toBe("Lifecycle view for task #11");
  });

  it("fails closed for unknown views and non-task lifecycle scopes", async () => {
    const unknownView = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=several&scope=all",
    );
    expect(unknownView.status.dataset.error).toBe("true");
    expect(unknownView.status.textContent).toBe(
      "view must be board, dependencies, or lifecycle",
    );

    const invalidLifecycle = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=lifecycle&scope=epic%3A10",
    );
    expect(invalidLifecycle.status.dataset.error).toBe("true");
    expect(invalidLifecycle.status.textContent).toBe(
      "lifecycle view requires task:<id> scope",
    );
  });

  it("ignores a stale graph after task lifecycle navigation", async () => {
    const harness = await clientHarness();
    const heldGraph = deferred<BrowserResponse>();
    harness.holdGraph("epic:10", heldGraph.promise);

    harness.navigateUrl(
      "http://console.test/?view=dependencies&scope=epic%3A10",
    );
    await delay(0);
    harness.navigateUrl("http://console.test/?view=lifecycle&scope=task%3A11");
    await vi.waitFor(() =>
      expect(harness.status.textContent).toBe("Lifecycle view for task #11"),
    );

    heldGraph.resolve(response({ edges: [], nodes: [] }));
    await delay(0);

    expect(harness.lifecycle.hidden).toBe(false);
    expect(harness.status.textContent).toBe("Lifecycle view for task #11");
    expect(harness.graphCanvas.children).toEqual([]);
  });

  it("renders a visible structured deferral on a ready card", async () => {
    const harness = await clientHarness([rootTask, deferredTask]);

    const readout = harness.elementsByClass("deferral-readout");
    expect(readout).toHaveLength(1);
    expect(readout[0]?.children.map(({ textContent }) => textContent)).toEqual([
      "DEFERRED",
      "2 / 2 active sessions",
    ]);
    expect(harness.cardIds()).toEqual(["10", "11"]);
  });

  it("renders the provider window reopen time", async () => {
    const harness = await clientHarness([rootTask, providerDeferredTask]);

    const readout = harness.elementsByClass("deferral-readout");
    expect(readout[0]?.children.map(({ textContent }) => textContent)).toEqual([
      "DEFERRED",
      "provider-a 80 / 80 until 1970-01-01T05:00:10.000Z",
    ]);
  });

  it("ignores a stale successful scope load after a newer failure", async () => {
    const harness = await clientHarness();
    const heldSuccess = deferred<BrowserResponse>();
    harness.holdProjection("task:11", heldSuccess.promise);

    harness.navigate("task:11");
    harness.navigate("epic:999");
    await vi.waitFor(() => expect(harness.status.dataset.error).toBe("true"));
    expect(harness.scope.selectedIndex).toBe(-1);
    expect(harness.cardIds()).toEqual([]);

    heldSuccess.resolve(response(projection([childTask])));
    await delay(0);

    expect(harness.status.dataset.error).toBe("true");
    expect(harness.scope.selectedIndex).toBe(-1);
    expect(harness.cardIds()).toEqual([]);
  });

  it("ignores a stale failed scope load after a newer success", async () => {
    const harness = await clientHarness();
    const heldFailure = deferred<BrowserResponse>();
    harness.holdProjection("epic:999", heldFailure.promise);

    harness.navigate("epic:999");
    harness.navigate("task:11");
    await vi.waitFor(() =>
      expect(harness.status.textContent).toBe("1 visible records"),
    );
    expect(harness.scope.value).toBe("task:11");
    expect(harness.cardIds()).toEqual(["11"]);

    heldFailure.resolve(
      response("scope epic:999 is invalid", { ok: false, status: 400 }),
    );
    await delay(0);

    expect(harness.status.dataset.error).toBe("false");
    expect(harness.scope.value).toBe("task:11");
    expect(harness.cardIds()).toEqual(["11"]);
  });
});
