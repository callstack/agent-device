---
'agent-device': minor
---

Clients attach to an existing daemon and no longer start, replace, or retire it on timeout. Remove `daemonLifecycle: 'managed'` and call `ensureDaemon({ stateDir })` before creating a client for a detached daemon. To own a daemon in your process, call `startAgentDevice({ stateDir })` from `agent-device` and close its returned handle. CLI and MCP commands continue to ensure their daemon.
