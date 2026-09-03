# iOS Simulator AX bridge decision verifier

This narrow harness supplies the decisive live evidence for [#2192](https://github.com/callstack/agent-device/issues/2192). It drives idb v1.5.2's in-Simulator `Resources/SimulatorFrameworkBridge` directly from Node over a private UNIX socket. It does not use `idb_companion`, gRPC, or Python, and it does not change production routing.

The checked-in September 1 broad raw corpus is retained because it contains the warm and relaunch measurements. Its one-off runner and generated NO-GO reports were removed after the corrected contract made them obsolete.

Obtain the guest executable from the official arm64 idb v1.5.2 release. The archive SHA-256 is `f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08`; `Resources/SimulatorFrameworkBridge` is `3545621d2dc98de32879ebac55e8b0c33dc8eb7cc2bfbc2d0d2d21a002c8de58`.

Run the verifier from a clean commit using the dedicated Simulator with the fixture app installed:

```sh
pnpm bench:ios-ax-bridge:targeted -- \
  --udid SIMULATOR_UDID \
  --guest-bridge /path/to/Resources/SimulatorFrameworkBridge
```

It captures five nonresident bootstrap samples after independently observing application readiness, then exercises crash, timeout, cancellation, and stale-generation recovery. Successful reads record guest CPU time and resident memory, and the corrected report fails closed if those metrics are missing or exceed the declared bounds.
