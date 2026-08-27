# Adding a CLI Flag

A new flag touches only the layers that need to understand it. Stop at the layer where it stops
mattering — threading it further is the common failure, not stopping too early.

1. `packages/contracts/src/cli-flags.ts`: add to `CliFlags`; add the definition to the matching
   `src/commands/cli-grammar/flag-definitions-*.ts` owner and the relevant group in `flag-groups.ts`
   (for example `SNAPSHOT_FLAGS`). Then update the command family metadata/schema that exposes the
   flag; find the owner with
   `rg -n "<command>|supportedFlags|allowedFlags" src/commands src/cli-schema src/cli/parser`. For
   schema-only CLI commands (`cdp`, `auth`, `connect`, `proxy`, `react-devtools`, `web`) the owner is
   `SCHEMA_ONLY_CLI_COMMAND_SCHEMAS` in `src/cli-schema/command-overrides.ts`. New flags are
   operator-only by default. Add a flag to `PROJECT_CONFIG_FLAG_KEYS` in
   `src/cli-schema/cli-config.ts` only when repository control is safe; this positive allowlist is
   the completeness gate.
2. `src/commands/cli-grammar/*`: read the CLI flag into command input.
3. `src/commands/command-projection.ts` and command-family projection helpers: write the input into
   the daemon request only if the flag affects daemon execution.
4. `src/commands/*-command-contracts.ts`: add to the command input schema only if the option should
   be available through Node.js or MCP as structured input. An input key that names a credential,
   an endpoint a credential is sent to, or operator infrastructure declares `operatorField(...)`
   (`src/commands/command-input.ts`), which is what keeps the MCP and AI SDK tool schemas from
   offering the model a parameter to write it into. One of the shared common keys declares the same
   audience in its `src/commands/common-input-fields.ts` row instead.
5. `src/client/client-types.ts`: update the public typed client option only when the Node.js
   interface exposes it.
6. `src/client/client-normalizers.ts`: update daemon flag normalization only when the request still
   needs a public-to-internal translation.
7. `src/daemon/context.ts` and `src/core/dispatch-context.ts`: add the field only when it flows into
   platform dispatch.
8. Handler/platform modules: thread the option only after the command surface, grammar, and
   projection prove it belongs there.
9. `scripts/integration-progress-model.ts`: classify the flag (device-observable vs
   intentionally-outside). The architecture-progress gate fails CI on unclassified public flags.
10. If the flag changes interaction semantics, revisit the affected cells in
    `packages/contracts/src/interaction-guarantees.ts` (scope with `appliesTo` when the flag exists only on
    some commands).

Command-only flags (like `find --first`) that never reach the platform layer usually stop at
steps 1-3, plus step 9.

## Where CLI help and schema live

- Long help prose: `src/cli-schema/cli-help.ts`. Flag definitions: `src/commands/cli-grammar/`.
- Command-specific usage/flag metadata lives with the command family metadata that owns the command.
- Parser/help *rendering* stays in `src/cli/parser/`; command schema metadata is derived from command
  metadata, family declarations, and the schema-only merge path in
  `src/cli-schema/command-overrides.ts`. Keep the two separate.
- Locating an owner: `rg -n "helpDescription|summary|supportedFlags|allowedFlags" src/commands src/cli/parser src/cli-schema`.
