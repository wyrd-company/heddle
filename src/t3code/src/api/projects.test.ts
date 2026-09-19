import { WebSocket as WsWebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeT3Server } from "../../test/support/fake-server.js";
import { makeShellProject, makeShellSnapshot } from "../../test/support/thread-fixtures.js";
import type { WebSocketConstructor } from "../internal/websocket.js";
import { RpcClient } from "../rpc/client.js";
import { rpcMethods } from "../rpc/registry.js";
import { projectId } from "../schemas/common.js";
import type { OrchestrationProjectShell } from "../schemas/orchestration/shell.js";
import { HttpTransport } from "../transport/http.js";
import { RpcConnection } from "../transport/rpc-connection.js";
import { SocketTransport } from "../transport/socket.js";
import { CommandDispatcher } from "./dispatch.js";
import { ProjectsApi, normalizeWorkspaceRoot } from "./projects.js";

describe("ProjectsApi", () => {
  let server: FakeT3Server;
  let connection: RpcConnection;
  let projects: ProjectsApi;
  let shellProjects: OrchestrationProjectShell[];
  let dispatched: Record<string, unknown>[];

  beforeEach(async () => {
    server = await FakeT3Server.start();
    shellProjects = [makeShellProject({ workspaceRoot: "/srv/sample/" })];
    dispatched = [];
    connection = new RpcConnection(new SocketTransport({ url: async () => server.wsUrl }));
    const rpc = new RpcClient(connection, rpcMethods);
    const http = new HttpTransport({
      baseUrl: server.httpUrl,
      fetch: server.fetch,
      getAccessToken: async () => "token-1",
    });
    projects = new ProjectsApi(http, rpc, new CommandDispatcher(rpc, http));
    server.routes.route("GET /api/orchestration/shell", () => ({
      status: 200,
      body: makeShellSnapshot({ projects: shellProjects }),
    }));
    server.handle("orchestration.dispatchCommand", (payload) => {
      const command = payload as Record<string, unknown>;
      dispatched.push(command);
      if (command["type"] === "project.create") {
        shellProjects.push(
          makeShellProject({
            id: command["projectId"],
            title: command["title"],
            workspaceRoot: command["workspaceRoot"],
          }),
        );
      }
      return { kind: "value", value: { sequence: dispatched.length } };
    });
  });
  afterEach(async () => {
    await connection.close();
    await server.close();
  });

  it("normalises workspace roots", () => {
    expect(normalizeWorkspaceRoot("/srv/sample/")).toBe("/srv/sample");
    expect(normalizeWorkspaceRoot("/srv/sample//")).toBe("/srv/sample");
    expect(normalizeWorkspaceRoot("/srv/./sample/../sample")).toBe("/srv/sample");
  });

  it("ensure returns the existing project without dispatching", async () => {
    const project = await projects.ensure({
      workspaceRoot: "/srv/sample",
      title: "Sample project",
    });
    expect(project.id).toBe("project-1");
    expect(dispatched).toEqual([]);
    expect(await projects.findByWorkspaceRoot("/srv/sample///")).toMatchObject({ id: "project-1" });
  });

  it("ensure creates a missing project once and finds it on the second call", async () => {
    const first = await projects.ensure({ workspaceRoot: "/srv/other", title: "Other" });
    const second = await projects.ensure({ workspaceRoot: "/srv/other/", title: "Other" });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "project.create",
      title: "Other",
      workspaceRoot: "/srv/other",
      projectId: first.id,
    });
    expect(second.id).toBe(first.id);
  });

  it("ensure renames an existing project when the title differs", async () => {
    await projects.ensure({ workspaceRoot: "/srv/sample", title: "Renamed" });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "project.meta.update",
      projectId: "project-1",
      title: "Renamed",
    });
  });

  it("delete resolves when the project does not exist and rethrows other failures", async () => {
    server.handle("orchestration.dispatchCommand", () => ({
      kind: "fail",
      error: {
        _tag: "OrchestrationDispatchCommandError",
        message:
          "Orchestration command invariant failed (project.delete): Project 'missing' does not exist for command 'project.delete'.",
      },
    }));
    await expect(projects.delete(projectId("missing"))).resolves.toBeUndefined();
    server.handle("orchestration.dispatchCommand", () => ({
      kind: "fail",
      error: {
        _tag: "OrchestrationDispatchCommandError",
        message: "Project 'project-1' is not empty and cannot be deleted without force=true.",
      },
    }));
    await expect(projects.delete(projectId("project-1"))).rejects.toMatchObject({
      code: "rpc_failed",
    });
  });

  it("rejects an invalid command before sending", async () => {
    await expect(projects.create({ title: "", workspaceRoot: "/srv/new" })).rejects.toMatchObject({
      code: "precondition",
    });
    expect(dispatched).toEqual([]);
  });
});

describe("CommandDispatcher HTTP fallback", () => {
  it("posts to /api/orchestration/dispatch when the socket is fatally unavailable", async () => {
    const server = await FakeT3Server.start({ token: "secret" });
    // No ticket and no bearer header: the upgrade is refused with 401 (fatal).
    const connection = new RpcConnection(
      new SocketTransport({
        url: async () => server.wsUrl,
        webSocket: WsWebSocket as unknown as WebSocketConstructor,
      }),
    );
    try {
      const rpc = new RpcClient(connection, rpcMethods);
      const http = new HttpTransport({
        baseUrl: server.httpUrl,
        fetch: server.fetch,
        getAccessToken: async () => "secret",
      });
      const posted: unknown[] = [];
      server.routes.route("POST /api/orchestration/dispatch", (request) => {
        posted.push(request.body);
        return { status: 200, body: { sequence: 7 } };
      });
      const dispatcher = new CommandDispatcher(rpc, http);
      const result = await dispatcher.dispatch({
        type: "thread.archive",
        commandId: dispatcher.newCommandId(),
        threadId: "thread-1" as never,
      });
      expect(result).toEqual({ sequence: 7 });
      expect(posted[0]).toMatchObject({ type: "thread.archive", threadId: "thread-1" });
      expect(server.upgrades[0]?.accepted).toBe(false);
    } finally {
      await connection.close();
      await server.close();
    }
  });
});
