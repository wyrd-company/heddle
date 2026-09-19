---
relationships:
  verifies:
    - node-types
    - agent-tools
  references: engine-and-run-model
---

# Pass qualification

The isolated qualification uses Claude Code 2.1.275, Codex 0.154.0, and T3 Code
production tree `3dc21446cfaeb20bec8953916f53d8aeb1357465`. The
[retained evidence](../../test/fixtures/pass-native-evidence.json) records relative
ordering, public native session identities, workflow results, and request timing.
It contains no endpoint credentials.

Each scenario uses a fresh server, harness profile, hook socket, and workflow
state. A fixture root can run only one scenario. Retained native session, thread,
and request identities are unchanged; redaction omits endpoint paths,
authorization values, and approval command text. Public T3 snapshots supply the
scenario participant identities. Retention rejects foreign callbacks and native
identities shared between independently qualified scenarios, and records a
SHA-256 digest of each raw ordering log.

The [guard evidence](../../test/fixtures/pass-guard-evidence.json) retains each
compiled mutation, its named failing tests, and the paired restored build and
full-suite result. Each source head names the committed input actually mutated;
each source-content digest matches the restored guarded file in this revision.
Later fixture and evidence-only commits do not alter those guarded files.
Compiler-invalid experiments do not count as test evidence.

| Scenario                              | Measured result                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude require-handoff                | Installed profile plugin blocks an early Stop with the reminder; handoff resumes once; final Stop allows.                                                          |
| Fixture-trusted Codex require-handoff | Installed profile plugin blocks an early Stop; handoff resumes once; final Stop allows.                                                                            |
| Untrusted Codex require-handoff       | No hook callback. Two observed turn ends carry the reminder; the cyclic blueprint stops at its authored bound.                                                     |
| Allow                                 | Actual turn settlement resumes with `turnEnded`.                                                                                                                   |
| Reuse, both harnesses                 | Two passes use the same T3 thread and native session ID. The prior Stop allows before replacement registration.                                                    |
| Kill during an active tool call       | Restart regenerates registration, recovers the stored subscription cursor, and accepts one handoff.                                                                |
| Kill after handoff commit             | The old token already returns 401. Restart removes the persisted terminal mapping before the hook listener starts; the final Stop allows and the run resumes once. |
| Concurrent isolation                  | Two active Heddle sessions use their own mappings. A third ordinary session allows with no policy call or Heddle run/event change.                                 |
| Approval timing                       | Both a shell approval and a handoff-tool approval appear in the pass read model before acceptance. Resolution follows the response.                                |

Normal handoff ordering is awaiting-row removal, immediate token rejection,
mapping and remote registration cleanup, successful MCP response, then native
Stop with inert allow. A process killed before returning the MCP response can
recover the committed handoff without repeating the resume. Cleanup cannot precede
awaiting-row removal: the committed boundary is the authority for revocation.

The [shared-lifetime control](../../test/fixtures/pass-shared-lifetime-control.json)
runs two scenarios against one server as an intentional isolation fault. It records
MCP GET requests with Authorization headers to the completed first pass endpoint
while the second fixture listens. Their SHA-256 endpoint fingerprints match the
first pass and differ from the active second pass; the responses are 401 with no
current endpoint owner. Header presence does not establish credential validity.
The fresh-lifetime qualification has no pre-terminal MCP 401 responses. The
kill-after-handoff scenario records one MCP POST returning 401 after the recovered
run is completed and its endpoint has no owner, before the final inert Stop.
Terminal policy 401 responses are explicit fixture probes after awaiting-row
removal.

The deterministic fixture uses the public session and activity events and the
client's projection tracker. Live observations establish two details it must retain:
normal user messages can identify Heddle's turn without a `turn-start-requested`
event; replay containing only a ready session can settle the durable prior turn
without the client tracker having observed its start in that connection. Approval
request and resolution timing agrees with the deterministic fixture.

The suite command is `node scripts/qualify-pass-suite.mjs <t3-source> <fresh-root>`.
It waits for the child server’s actual HTTP listening event before starting each
scenario and stops that server and its recorded descendants in unconditional
cleanup. `node scripts/retain-pass-evidence.mjs <root>/manifest.json <output>`
validates provenance and produces the redacted evidence. The manifest records the
committed Heddle input before the subsequent evidence-only commit.

The scripts `pass-live-server.mjs` and `qualify-pass-live.mjs` create isolated
profiles, server state, workflow state, and workspaces. Native credential files are
referenced through symlinks; their contents are not read by the fixture scripts.
Only the trusted-blocking fixture writes Codex trust state. Plugin installation has
no trust prerequisite and does not write operator trust settings. The service
fixture uses the production engine, pass service, generated tools, hook server, and
direct T3 client. The scenarios inject process death through SIGKILL, not a mocked
restart callback.
