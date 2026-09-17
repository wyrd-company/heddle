---
relationships:
  implements:
    - t3-code-client
    - agent-tools
    - node-types
---

# T3 Code client

TypeScript client for the T3 Code server: HTTP API, WebSocket RPC, the auth
control plane, and the Wyrd Company fork's external MCP registration. It lets
a Node program dispatch, manage, and monitor agent sessions that a person can
also open in a normal T3 Code client.

- No Effect dependency. The library speaks the server's wire formats directly
  and models them with `zod`; the surface is `Promise` and `AsyncIterable`.
- Forward compatible. Unknown keys pass through, unknown union members decode
  as `{ unknown: true, raw }`, and a stream keeps flowing when one item fails
  to decode.
- One credential. A bearer access token, obtained by exchanging a pairing
  token or issued by `t3 auth session issue`.

This is an internal Heddle module. Its technical design is
`docs/technical-designs/t3-code-client.yml` from the repository root. The
repository `AGENTS.md` is the canonical testing and live-environment guide.

## Module boundary

Heddle code imports the preserved public surface through the module entry:

```ts
import { T3Client, fileCredentialStore } from "./t3code/index.js";
```

The module is ESM and uses the Node built-in `WebSocket`. Tests and callers
that need bearer-header socket authentication can pass the `ws` implementation.

## Quick start

```ts
import { T3Client, fileCredentialStore } from "./t3code/index.js";

const client = T3Client.create({
  baseUrl: "http://127.0.0.1:3000",
  credentials: fileCredentialStore("/var/lib/workflows/t3-credentials.json"),
  clientLabel: "sdlc-workflows",
});

// First run: exchange a pairing token (from `t3 pair` or `t3 auth pairing create`).
await client.auth.exchangePairingToken("ABCDEF123456");
// Or: await client.auth.setAccessToken(process.env.T3_TOKEN);

const project = await client.projects.ensure({ workspaceRoot: "/srv/repo", title: "repo" });
const thread = await client.threads.ensure({
  threadId: stableThreadId, // a ThreadId you generate and remember
  projectId: project.id,
  title: "Review pull request 42",
  modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
  runtimeMode: "auto",
});

// Give the agent your tools before its session starts.
await client.mcp.ensureRegistration({
  threadId: thread.id,
  name: "workflow",
  endpoint: "https://workflows.example.internal/mcp",
  authorizationHeader: `Bearer ${sessionToken}`,
});

const turn = await client.threads.startTurn({ threadId: thread.id, text: "Review the diff." });
for await (const item of turn.events()) {
  switch (item.kind) {
    case "assistant-delta":
      process.stdout.write(item.text);
      break;
    case "approval-requested":
      await client.threads.respondToApproval({
        threadId: thread.id,
        requestId: item.requestId,
        decision: "accept",
      });
      break;
    case "user-input-requested":
      await client.threads.respondToUserInput({
        threadId: thread.id,
        requestId: item.requestId,
        answers: Object.fromEntries(item.questions.map((q) => [q.id, "yes"])),
      });
      break;
  }
}
const outcome = await turn.completion; // { state: "completed" | "interrupted" | "error", assistantMessage, thread }

await client.close();
```

## What is where

| Facade            | Purpose                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `client.auth`     | Session state, pairing-token exchange, tickets, pairing links, connected clients, scopes.            |
| `client.server`   | Environment descriptor, config and provider catalog, settings, config and lifecycle streams.         |
| `client.projects` | List, get, ensure, update, delete projects; project file reads, writes, and searches.                |
| `client.threads`  | List, get, detail, ensure, update, archive, delete; turns, interrupts, approvals, user input; watch. |
| `client.shell`    | The lightweight projects-and-threads snapshot and its live stream.                                   |
| `client.mcp`      | Register, clear, ensure, or scope an external MCP server for a thread (fork only).                   |
| `client.vcs`      | Refs, status, worktrees, branches.                                                                   |
| `client.terminal` | Open, attach, write, resize, close terminals.                                                        |
| `client.rpc`      | Typed `call` and `stream` for every registered method, plus `callRaw` and `streamRaw` for the rest.  |

## Idempotent operations

| Operation                | Key                        | Behaviour                                                                     |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------- |
| `projects.ensure`        | normalised `workspaceRoot` | returns the existing project, renames it when the title differs, else creates |
| `threads.ensure`         | caller-supplied `threadId` | returns the existing thread (active or archived), else creates                |
| `mcp.ensureRegistration` | `(threadId, name)`         | validated `PUT`; the server replaces the entry                                |
| `auth.setAccessToken`    | token                      | validates, then stores                                                        |
| `*.delete`, `mcp.clear`  | id                         | an absent resource resolves without error                                     |

Registration takes effect only when the provider session next starts, so
register before the first turn on a thread. `mcp.withRegistration` registers,
runs your function, and clears in `finally`.

## Errors

Every failure is a `T3Error` with a stable `code`:

| Class                 | `code`                               | When                                               |
| --------------------- | ------------------------------------ | -------------------------------------------------- |
| `T3AuthError`         | `auth_invalid`, `insufficient_scope` | 401 or 403, or a scope check before sending        |
| `T3NotFoundError`     | `not_found`                          | 404                                                |
| `T3HttpError`         | `http`                               | any other non-2xx                                  |
| `T3RpcError`          | `rpc_failed`                         | the server answered an RPC with a tagged error     |
| `T3RpcDefectError`    | `rpc_defect`                         | the server died handling an RPC                    |
| `T3ConnectionError`   | `connection`                         | socket open failed, closed, ping timeout, protocol |
| `T3DecodeError`       | `decode`                             | a server payload did not match the schema          |
| `T3PreconditionError` | `precondition`                       | invalid input caught before sending                |
| `T3InterruptedError`  | `interrupted`                        | a call or stream was cancelled                     |

## Watching threads

`client.threads.watch(threadId)` yields the server's stream items
(`snapshot`, `synchronized`, `event`) plus derived items: `assistant-delta`,
`approval-requested`, `user-input-requested`, `request-resolved`,
`turn-settled`, `decode-error`, and `reconnected` after the socket was lost
and the subscription resumed from the last sequence. Pass `afterSequence`
to resume from a sequence you stored.

## Verification

```bash
task check
task test:t3code-live
```

The live command, environment variables, and isolated-server helper are
documented in the repository `AGENTS.md`.
