# HarmonyOS uninstall route with post-uninstall verification, 2026-11-12

Evidence for #4292: the public `uninstall` command runs the route end to end
on hardware. The route at e36de175b answers bundle state twice from the
`bm dump -a` inventory through the shared `parseHarmonyBundleList` (one owner
with the app-lifecycle list), and removal counts only when a non-empty
inventory no longer lists the bundle; the `bm uninstall` answer and any
unparseable read are never proofs, because `bm` prints its verdict into stdout
at host exit code 0 on this build (see `harmonyos-uninstall-2026-11-08.md`
for the recorded shapes).

## Device and build

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Physical device over USB, `hdc shell` as uid 2000 (shell)
- agent-device head `e36de175b`, built in the contribution worktree, daemon restarted clean
- Target bundle: `com.stringzhao.adtrajdriver`, the debug-signed harness HAP
  from this contribution's own tooling (`examples/harmony-trajectory-driver`);
  no user data involved.

## The route under test

```sh
agent-device install <entry-debug-signed.hap> --platform harmonyos --serial 77TYD26826028730 --json
agent-device uninstall com.stringzhao.adtrajdriver --platform harmonyos --serial 77TYD26826028730 --json
agent-device uninstall com.stringzhao.adtrajdriver --platform harmonyos --serial 77TYD26826028730 --json
```

## Observed output (verbatim)

Abridged install answer (the full payload also carries the resolved
`appPath`, elided here for length):

```json
{
  "success": true,
  "data": {
    "app": "com.stringzhao.adtrajdriver",
    "appId": "com.stringzhao.adtrajdriver",
    "package": "com.stringzhao.adtrajdriver",
    "message": "Installed: com.stringzhao.adtrajdriver"
  }
}
```

Uninstall reports removal, and a host-side `bm dump -a | grep adtrajdriver`
right after matches nothing — the inventory the route itself reads no longer
lists the bundle, so the route's post-check agreed with the hardware:

```json
{
  "success": true,
  "data": {
    "platform": "harmonyos",
    "app": "com.stringzhao.adtrajdriver",
    "wasInstalled": true,
    "appId": "com.stringzhao.adtrajdriver",
    "message": "Uninstalled: com.stringzhao.adtrajdriver"
  }
}
```

Inventory membership around the uninstall, read verbatim on the host:

```
$ hdc -t 77TYD26826028730 shell "bm dump -a" | grep adtrajdriver   # after install
	com.stringzhao.adtrajdriver
$ hdc -t 77TYD26826028730 shell "bm dump -a" | grep -c adtrajdriver  # after uninstall
0
```

A second uninstall answers honestly that nothing was removed:

```json
{
  "success": true,
  "data": {
    "platform": "harmonyos",
    "app": "com.stringzhao.adtrajdriver",
    "wasInstalled": false,
    "message": "Not installed: com.stringzhao.adtrajdriver"
  }
}
```

## What is proven here and what is not

- The public `uninstall` route, the deployment-runtime admission for a physical
  `device` denominator, and the post-uninstall inventory re-read all ran on
  hardware at a named commit.
- The `wasInstalled: false` branch ran against a genuinely absent bundle: the
  inventory re-read answered non-empty without the target, which also proves
  the transport was live.
- The "inventory still lists the bundle" refusal (a `bm` that answers success
  but leaves the bundle) has no hardware reproduction on this build; the unit
  test `uninstall refuses to claim removal when the inventory still lists the
  bundle` pins the behavior with the recorded output shapes, alongside the
  unknown-read and failed-exit refusals the inventory read now carries.
- Local `check:affected --run --base old-origin/main` at e36de175b passes
  every stage except `unit`; `unit` fails only
  `scripts/__tests__/eager-closure-budgets.test.ts` because this clone's
  `origin` names a private fork, so the gate reads the wrong merge base. With
  `refs/remotes/origin/main` pointed at the upstream head for the duration of
  one `pnpm run check:unit`, that chain exits 0. Both receipts are local; the
  authoritative run is CI at a1787af (16 checks, none failing), a commit that
  changes only comments after this run's sources.
