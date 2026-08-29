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
  className = "";
  disabled = false;
  draggable = false;
  textContent = "";
  type = "";

  constructor(readonly tagName: string) {}

  addEventListener(): void {}

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

const projection = (tasks: unknown[]) => ({
  columns: [{ status: "in-progress", tasks }],
});

const clientHarness = async () => {
  const board = new FakeElement("div");
  const scope = new FakeSelect();
  scope.replaceChildren(new FakeOption("All work", "all"));
  const status = new FakeElement("p");
  const attention = new FakeElement("span");
  let locationHref = "http://console.test/?scope=all";
  const windowListeners = new Map<string, () => void>();
  const projectionResponses = new Map<string, Promise<BrowserResponse>>();

  const fetch = async (input: string): Promise<BrowserResponse> => {
    if (input === "/api/board") {
      return response({ tasks: [rootTask, childTask] });
    }
    if (input === "/api/attention") return response([]);
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
        return response(projection([rootTask, childTask]));
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
    querySelector: (selector: string) => {
      if (selector === "#board") return board;
      if (selector === "#scope") return scope;
      if (selector === "#console-status") return status;
      if (selector === "#attention-count") return attention;
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

  await vi.waitFor(() => expect(status.textContent).toBe("2 visible records"));

  const cardIds = (): string[] => {
    const visit = (element: FakeElement): FakeElement[] => [
      element,
      ...element.children.flatMap(visit),
    ];
    return visit(board)
      .filter(({ tagName }) => tagName === "article")
      .map(({ dataset }) => dataset.taskId!);
  };

  return {
    board,
    cardIds,
    holdProjection: (name: string, held: Promise<BrowserResponse>) => {
      projectionResponses.set(name, held);
    },
    navigate: (name: string) => {
      locationHref = `http://console.test/?scope=${encodeURIComponent(name)}`;
      windowListeners.get("popstate")!();
    },
    scope,
    status,
  };
};

describe("console client request ownership", () => {
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
