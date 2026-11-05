---
'agent-device': patch
---

Fix the daemon retaining about 74 KB for every iOS Simulator snapshot read through the host AX bridge, which grew a long-running daemon's memory without bound. Each snapshot request registered its own exit reaction on the bridge process, and that reaction kept the request's response buffers reachable until the bridge exited. The bridge process now carries one exit reaction however many snapshots it serves.
