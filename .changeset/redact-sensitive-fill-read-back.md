---
'agent-device': patch
---

Keep the read-back of a sensitive `fill` (`--text-stdin` or `--record-as`) out of responses and errors. An unconfirmed fill returns the redaction placeholder for `requested`, `before`, and `after`, and an Android fill failure does the same for `expected`, `actual`, and the observed input text. The iOS `TEXT_ENTRY_MISMATCH` message no longer quotes the expected or observed text.
