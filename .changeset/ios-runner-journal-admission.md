---
'agent-device': patch
---

Prevent repeated Apple runner interactions with the same command ID from executing twice while allowing read-only retries, including selector queries, to read again. If a repeat cannot replay the finished command's result, return `COMMAND_ALREADY_FINISHED` with `error.details.dispatched: unknown`. Run `snapshot -i` to inspect the screen before deciding whether to send another interaction.
