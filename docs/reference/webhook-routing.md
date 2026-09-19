---
relationships:
  implements: command-line-interface
  references: github-binding-and-intake
---

# GitHub webhook host routing

Listening is disabled by default. Choose an available stable port and configure
both `webhook.listen.host` and `webhook.listen.port` in the service configuration.
There is no default port. This example explicitly selects port 8421:

```yaml
webhook:
  secretFile: /run/secrets/heddle-webhook-secret
  listen:
    host: 127.0.0.1
    port: 8421
```

The recommended host is `127.0.0.1` behind a proxy or tunnel. Its forwarding
process must reach the service's loopback interface. A host-side proxy cannot
reach a container's loopback address directly. Place the forwarding process in
the container, or explicitly configure another bind interface, such as
`0.0.0.0`, with the host/container forwarding needed for that interface.

The host configures the public HTTPS delivery URL and forwards its
`/webhook/github` path to the configured HTTP listener. Preserve the request
body and GitHub signature headers. The startup route is the bind target, not
necessarily the public URL; a wildcard address is not a public delivery URL.
Heddle does not configure TLS, proxies, tunnels, or container port forwarding.
Only `POST /webhook/github` is served. Keep the public target on this listener;
generated tools, hook sockets, tokens, and SQLite state have no external route.

The external webhook body ceiling is 25 MiB (26,214,400 bytes). A declared
`Content-Length` above that ceiling returns 413 before body accumulation.
Streamed bytes are counted independently, so chunked transfer without
`Content-Length` cannot bypass the ceiling. Overflow returns 413 and closes the
connection before retaining the overflowing chunk. Exactly-at-limit bodies
continue through signature verification and dispatch. This per-request ceiling
does not bound aggregate concurrent memory or connection duration.

Signature verification uses the original body bytes and precedes JSON parsing.
Authenticated valid-JSON deliveries for named unsupported events, including
GitHub's creation `ping`, return 202 without invoking binding mutation.
A missing or invalid signature returns 401. A missing or malformed event name
and invalid JSON return 400. Genuine supported-event payload and dispatch
failures return 500. An event name starts with a lowercase letter and contains
only lowercase letters, digits, and underscores.

Generated tools never move onto this listener. They stay on the internal
listener that `agentTools.listen.host` and `agentTools.listen.port` configure,
whose address is also stable so that endpoints registered before a restart stay
reachable after it.

The Feature uses these same YAML keys from its `configFile` mount.
`webhookSecretFile` changes only the secret-file path. The generated Feature
configuration has no webhook `listen` block; it does carry an
`agentTools.listen` block from the `agentToolsPort` option. Polling remains supported independently.

## Acceptance checks

Use isolated GitHub and T3 Code fixtures and a disposable state directory.
Keep the configured target unchanged throughout these checks.

1. Start Heddle with the selected host and port. Confirm startup reports
   `webhook=http://<host>:<port>/webhook/github` without tool endpoints or tokens.
2. Confirm GitHub's creation `ping` receives HTTP 202 without an instance change.
   Send a signed supported GitHub delivery through the host route and confirm
   HTTP 202 and the expected instance change. Confirm an invalid signature
   returns 401 and a request to another path,
   including `/hook/stop`, returns 404 with no internal data.
3. Send SIGTERM, wait for process exit, and restart with the same configuration
   and state. Deliver to the unchanged public URL after startup completes.
4. Send SIGKILL, wait for process exit, and restart with the same configuration
   and state. Confirm recovery completes before delivery is accepted; send to
   the same public URL and confirm the expected bound instance update.
5. Remove `webhook.listen`, restart, and confirm `webhook=disabled`. Confirm
   polling still delivers the equivalent issue change.

Repository evidence runs the production listener through graceful restart and
SIGKILL in `test/service-recovery.test.ts`. It holds pass recovery open to prove
the external port is closed, then tests signed delivery at the unchanged target.
It also sends a real generated-tool path and credential to the external listener
and verifies rejection before using that credential on the internal listener.
The host proxy or tunnel itself requires the acceptance checks above.
