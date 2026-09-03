# Domain Docs

Single-context repo. Before architecture, diagnosis, TDD, triage, PRD, or roadmap work, read
`CONTEXT.md` for domain vocabulary and the relevant ADRs in `docs/adr/`. Selector-capture work also
reads `docs/agents/selector-capture.md`.

Use `CONTEXT.md` vocabulary in issue titles, refactor proposals, test names, and architecture notes.
If a proposed change contradicts an ADR, say so explicitly and explain why the decision should be
reopened.

`AGENTS.md` routes to the rest of this directory by task type.

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
