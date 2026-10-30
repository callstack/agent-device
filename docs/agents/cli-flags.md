# Adding a CLI Flag

Pass a flag only through layers that consume it:

1. Add the flag to `CliFlags` in `packages/contracts/src/cli-flags.ts`.
   Add its definition to the owner in `packages/command-registry/src/flag-definitions-*.ts`.
   Add it to the applicable group in `packages/command-registry/src/flag-groups.ts`, for example `SNAPSHOT_FLAGS`.
   Update the command family metadata/schema that exposes the flag.
   To find the owner, run `rg -n "<command>|helpDescription|summary|supportedFlags|allowedFlags" packages/command-surface/src src/commands src/cli/parser`.
   For schema-only CLI commands, use `SCHEMA_ONLY_CLI_COMMAND_SCHEMAS` in `packages/command-surface/src/schema/command-overrides.ts`.
   Each flag declaration requires `projectConfig` and `recorded`.
   `projectConfig` permits a project `agent-device.json` to set the flag.
   `recorded` makes the session recorder copy it into `SessionAction.flags`.
   Only when repository control is safe, set `projectConfig: true`. Otherwise, a new flag is operator-only.
   Only when a `.ad` recording must carry the flag, set `recorded: true`.
2. In `packages/command-surface/src/cli-grammar/*`, read the CLI flag into command input.
3. If the flag affects daemon execution, write the input into the daemon request.
   Use `packages/command-surface/src/index.ts` (`prepareDaemonCommandRequest`) and the command-family projection helpers.
4. If Node.js or MCP should expose structured input, add a field to the command's field map. `defineFieldCommandMetadata` generates `inputSchema` and the audience.
   For a credential, its destination endpoint, or operator infrastructure, declare the input key with `operatorField(...)` (`packages/command-surface/src/command-input.ts`).
   MCP and AI SDK tool schemas thus exclude parameters for the model to write that input.
   For a shared common key, declare the same audience in its `packages/command-surface/src/common-input-fields.ts` row instead.
5. If Node.js exposes the option, update the public typed client option in the owning `packages/contracts/src/client-*.ts` type.
6. If the request still needs public-to-internal translation, update daemon flag normalization in `src/client/client-normalizers.ts`.
7. If the field enters platform dispatch, add it to `packages/daemon/src/core/context.ts` and `packages/daemon/src/core/dispatch-context.ts`.
8. Only after the command surface, grammar, and projection prove applicability, pass the option through handler/platform modules.
9. In `scripts/integration-progress-model.ts`, classify the flag as device-observable or intentionally-outside.
10. If the flag changes interaction semantics, examine the affected cells in `packages/contracts/src/interaction-guarantees.ts` again.
    If only some commands have the flag, use `appliesTo` to limit its scope.

## Where CLI help and schema live

- Long help prose is in `src/commands/schema/cli-help.ts`.
  CLI input readers are in `packages/command-surface/src/cli-grammar/`.
- `src/commands/schema/usage.ts` generates the synopsis `[label]` flag tail from `allowedFlags`.
  Only when the command synopsis names fewer options, declare `usageFlags`.
  For pure grammar or grammar with its own mutually-exclusive brackets, use `[]`.
  Otherwise, use the subset it names. `Command flags:` always lists all of `allowedFlags`.
  For an opt-in across commands, set `usageHidden: true` on its flag definition. This excludes it from every synopsis.
- If the first positional selects an action, declare `flagsByAction` on the CLI schema.
  Map each action to the options it reads. Derive `allowedFlags` from that table.
  From caller-supplied keys, the parser rejects typed options that the action never reads.
  Options the selected action ignores stay out of its request, even when config, env, or remote-config defaults set them. Thus, `AGENT_DEVICE_FPS=30` never breaks `record stop`.
  Exclude options that every action reads from the table.
  The parser rejects only options in rows. If it rejected `--json`, it would reject the command.
- Keep command-specific usage/flag metadata with the command family metadata that owns the command.
- Keep argument parsing in `src/cli/parser/`. Keep help rendering in `src/commands/schema/`.
  Command schema metadata derives from command metadata, family declarations, and the schema-only merge in `packages/command-surface/src/schema/command-overrides.ts`.
