---
'agent-device': minor
---

Install local plugin tarballs with `plugins add` or the plugin manager API. Artifact selections record their version and SHA-512 integrity. To replace one, run `plugins remove <package>` and then `plugins add ./plugin.tgz`. Close active sessions and restart the daemon to apply the changed selection.
