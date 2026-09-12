# Changelog

## 0.1.0

### Features

- Retain each session's resolved provider and runtime binding.
- Select stage sessions from task and blueprint provider aliases.
- Resolve configured provider aliases against T3.
- Expose configured provider aliases and select delegated sessions by alias.
- Route harness questions through one durable answer contract with per-question reasoning and continued work until obligations complete.
- Dispatch resolved T3 providers without a driver roster.

### Fixes

- Skip unusable provider candidates while preserving ordered fallback evidence.
