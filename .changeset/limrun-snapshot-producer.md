---
'agent-device': patch
---

Limrun iOS snapshots no longer use the `limrun-ios-tree` producer. Bridge captures report `simulator-ax-bridge`; captures that fall back to XCTest report `apple-runner`. If you inspect saved snapshot provenance, continue to handle the older `limrun-ios-tree` value for historical captures.
