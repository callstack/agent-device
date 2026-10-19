# ADR 0003: Daemon Command Registry (redirect)

## Status

Accepted; absorbed into [ADR 0008](0008-command-descriptor-registry.md) on 2026-10-19 (#3744).

This record no longer holds an independent decision. The daemon-command
registry decision stated here merged into ADR 0008, which now states the
current truth. Read ADR 0008 for:

- The separately typed `daemon` facet as the single declaration of daemon
  route and request-policy traits, and the derived daemon registry.
- The predicate-only access boundary: only
  `packages/daemon/src/core/daemon-command-registry.ts` exposes named
  request-policy predicates; request modules and handlers do not recreate
  command sets or route coverage tables.
- The public-projection boundary: no public contract derives from daemon-only
  traits; a diagnostic display such as `command explain` may show them. This
  is an ownership constraint, not type enforcement.
- The missing-facet default: a command without a `daemon` facet uses the
  `generic` route and the default request policy, with no compile error.

## Decision history

- 2026-10-19 — The #3744 ADR restructure merged this record into ADR 0008. The
  accepted decisions did not change; ADR 0008 absorbed the corrected
  2026-10-16 invariants.
