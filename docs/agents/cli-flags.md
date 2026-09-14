# Adding a CLI Flag

Thread a flag only through the layers that consume it:

1. `packages/contracts/src/cli-flags.ts`: add to `CliFlags`; add the definition to the matching
   `src/commands/cli-grammar/flag-definitions-*.ts` owner and the relevant group in `flag-groups.ts`
   (for example `SNAPSHOT_FLAGS`). Then update the command family metadata/schema that exposes the
   flag; find the owner with
   `rg -n "<command>|supportedFlags|allowedFlags" src/commands src/cli-schema src/cli/parser`. For
   schema-only CLI commands, the owner is `SCHEMA_ONLY_CLI_COMMAND_SCHEMAS` in
   `src/cli-schema/command-overrides.ts`. Every flag declaration states `projectConfig`
   (may be set from a project `agent-device.json`) and `recorded` (the session recorder
   copies it into `SessionAction.flags`). Both are required, so a new declaration that
   omits either does not compile — that, not an allowlist, is the completeness gate. Set
   `projectConfig: true` only when repository control is safe; a new flag is otherwise
   operator-only. Set `recorded: true` only when a `.ad` recording must carry the flag.
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
- Synopsis: `src/cli-schema/usage.ts` generates the `[label]` flag tail from `allowedFlags`, so a
  new option reaches `--help` without any synopsis edit. Declare `usageFlags` on the command only
  when its synopsis names fewer options: `[]` for a synopsis that is pure grammar (or writes its own
  mutually-exclusive brackets), otherwise the subset it names. `Command flags:` always lists
  everything in `allowedFlags`. Keep a cross-cutting opt-in out of every synopsis with
  `usageHidden: true` on its flag definition. `src/cli-schema/usage.test.ts` fails a tail that names
  an option the command does not accept, or one the hand-written grammar already wrote.
- Command-specific usage/flag metadata lives with the command family metadata that owns the command.
- Parser/help *rendering* stays in `src/cli/parser/`; command schema metadata is derived from command
  metadata, family declarations, and the schema-only merge path in
  `src/cli-schema/command-overrides.ts`. Keep the two separate.
- Locating an owner: `rg -n "helpDescription|summary|supportedFlags|allowedFlags" src/commands src/cli/parser src/cli-schema`.
