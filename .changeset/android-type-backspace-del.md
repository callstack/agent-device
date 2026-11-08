---
'agent-device': patch
---

Fix Android text input typing `\b` backspaces as literal characters into fields instead of deleting characters. Sequences composed entirely of backspaces are now dispatched via `KEYCODE_DEL` keyevents across all Android input targets.
