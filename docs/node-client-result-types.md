# Node client result types

The `0.20` minor line intentionally narrows public TypeScript return types when a command has an
accurate, closed daemon result contract. Runtime payloads are unchanged. This is source-compatible
for callers that only read real response fields, but TypeScript code that indexed arbitrary keys
from the former `Record<string, unknown>` result must switch to the declared fields or explicitly
narrow an external payload at its own trust boundary.

The closed-result batch covers:

- `command.doctor`
- `capture.diff` (`kind: 'snapshot'`)
- `replay.run`
- `replay.test`
- `recording.record`
- `recording.trace`

Their canonical result types live in `src/contracts`, feed `CommandResultMap`, and have matching MCP
output schemas.

The remaining broad methods are deliberate:

- `command.alert` and `command.reactNative` spread platform/interaction-specific data.
- The interaction family (`click` through `find`) needs one public response projection reconciled
  with settle/evidence and fast-path additions before its existing runtime contracts are safe as
  public return types.
- Observability (`perf`, `logs`, `events`, `network`, `audio`) is action- and backend-dependent.
- `settings.update` spreads backend-specific setting data.

Those methods remain `CommandRequestResult` until their producers expose accurate closed public
contracts. Do not narrow them with casts, compatibility aliases, or invented partial shapes.
