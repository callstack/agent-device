# iOS Simulator AX bridge decision verifier

This narrow harness supplies the decisive live evidence for [#2192](https://github.com/callstack/agent-device/issues/2192). It drives idb v1.5.2's in-Simulator `Resources/SimulatorFrameworkBridge` directly from Node over a private UNIX socket. It does not use `idb_companion`, gRPC, or Python, and it does not change production routing.

The September 1 broad corpus is retained for its warm measurements and diagnostics. Its one-off Python runner and generated NO-GO reports were removed after the corrected contract made them obsolete. The corrected relaunch corpus is Node-direct. Raw artifacts are kept off-tree at immutable tag `evidence/ios-snapshot/44995806ea` (commit `f8b2fab28b8604f20094785c16e16a79fdc651a3`); their SHA-256 hashes are recorded in the evidence branch README.

Obtain the guest executable from the official arm64 idb v1.5.2 release. The archive SHA-256 is `f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08`; `Resources/SimulatorFrameworkBridge` is `3545621d2dc98de32879ebac55e8b0c33dc8eb7cc2bfbc2d0d2d21a002c8de58`. The verifier hashes the supplied `--guest-bridge` before launching it and fails if it is not that binary.

Fetch the broad input before rerunning:

```sh
git fetch origin refs/tags/evidence/ios-snapshot/44995806ea
git show evidence/ios-snapshot/44995806ea:ios-simulator-ax-bridge-broad-268a90275.json.gz \
  > docs/evidence/ios-simulator-ax-bridge-2026-09-01-final.json.gz
shasum -a 256 docs/evidence/ios-simulator-ax-bridge-2026-09-01-final.json.gz
```

The expected broad artifact hash is `309f974b1dcb90768548a189f6af58b493b5d7b9d56a5bfad060d4335139eb7b`.

Run the verifier from a clean commit using the dedicated Simulator with the fixture app installed:

```sh
pnpm bench:ios-ax-bridge:targeted -- \
  --udid SIMULATOR_UDID \
  --guest-bridge /path/to/Resources/SimulatorFrameworkBridge
```

It captures five nonresident bootstrap samples after independently observing application readiness. It then captures 20 relaunches on each of the six representative screens through the Node-direct route; every timed read is paired with a separate readiness probe for the exact relaunched PID and expected screen anchor. Finally it exercises crash, timeout, cancellation, and stale-generation recovery. Successful reads record guest CPU time and resident memory, and the corrected report fails closed if those metrics are missing or exceed the declared bounds.
