# Adding a CLI Flag

Pass a flag only through layers that read it:

1. Add the flag to `CliFlags` in `packages/contracts/src/cli-flags.ts`.
   Add its definition to the owner in `packages/command-registry/src/flag-definitions-*.ts`.
   Add it to its group in `packages/command-registry/src/flag-groups.ts`, for example `SNAPSHOT_FLAGS`.
   Update the command family metadata/schema that exposes the flag.
   To find the owner, run `rg -n "<command>|helpDescription|summary|supportedFlags|allowedFlags" packages/command-surface/src src/commands src/cli/parser`.
   For schema-only CLI commands, use `SCHEMA_ONLY_CLI_COMMAND_SCHEMAS` in `packages/command-surface/src/schema/command-overrides.ts`.
   Set `projectConfig: true` only when repository control is safe. Otherwise, a new flag is operator-only.
   Only when a `.ad` recording must carry the flag, set `recorded: true`.
2. In `packages/command-surface/src/cli-grammar/*`, read the CLI flag into command input.
3. If the flag affects daemon execution, write the input into the daemon request.
   Use `packages/command-surface/src/index.ts` (`prepareDaemonCommandRequest`) and the command-family projection helpers.
4. To expose structured input to Node.js or MCP, add a field to the command's field map. `defineFieldCommandMetadata` generates `inputSchema` and the audience.
   For a credential, its destination endpoint, or operator infrastructure, declare the input key with `operatorField(...)` (`packages/command-surface/src/command-input.ts`).
   MCP and AI SDK tool schemas then omit that input.
   For a shared common key, declare the same audience in its `packages/command-surface/src/common-input-fields.ts` row instead.
5. If Node.js exposes the option, update its typed client option in `packages/contracts/src/client-*.ts`.
6. For remaining public-to-internal translation, update daemon flag normalization in `packages/client/src/client-normalizers.ts`.
7. If the field enters platform dispatch, add it to `packages/daemon/src/core/context.ts` and `packages/daemon/src/core/dispatch-context.ts`.
8. Pass the option through handler/platform modules only after the command surface, grammar, and projection prove applicability.
9. In `scripts/integration-progress-model.ts`, classify the flag as device-observable or intentionally-outside.
10. If the flag changes interaction semantics, re-examine the affected cells in `packages/contracts/src/interaction-guarantees.ts`.
    If only some commands have the flag, use `appliesTo` to limit its scope.

## CLI help and schema

- Long help prose is in `src/commands/schema/cli-help.ts`.
- `src/commands/schema/usage.ts` generates the synopsis `[label]` flag tail from `allowedFlags`.
  Only when the command synopsis names fewer options, declare `usageFlags`.
  For pure grammar or grammar with its own mutually-exclusive brackets, use `[]`.
  Otherwise, use the subset it names. `Command flags:` always lists all of `allowedFlags`.
  To hide a cross-command opt-in from every synopsis, set `usageHidden: true` on its flag definition.
- If the first positional selects an action, declare `flagsByAction` on the CLI schema.
  Map each action to the options it reads. Derive `allowedFlags` from that table.
  Exclude options that every action reads from the table.
- Keep argument parsing in `src/cli/parser/`. Keep help rendering in `src/commands/schema/`.
