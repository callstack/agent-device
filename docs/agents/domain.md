# Domain Docs

Use `CONTEXT.md` for domain vocabulary and `docs/adr/README.md` to locate decisions relevant to the
change. A proposed ADR contradiction requires an explicit decision update.

## Test-harness vocabulary

**Provider-backed integration scenario**:
A device-free test through the real daemon request path that replaces only external device or host
tool execution.

**Provider transcript**:
An exact record of external provider calls used to verify command translation.

**Scenario transcript**:
A command-level integration flow describing user-visible behavior through daemon commands.

**In-process provider scenario harness**:
An integration runner that invokes the daemon request handler without opening an HTTP listener.

**HTTP contract test**:
A narrow test of JSON-RPC transport, authentication, and response finalization.
