# HarmonyOS uninstall route with post-uninstall verification, 2026-11-12

Evidence for #4292: the public `uninstall` command runs the fixed route end to
end on hardware. The fix at 31dfcd012 keys removal success on a second
`bm dump` that no longer finds the bundle record, not on the `bm uninstall`
answer, because `bm` prints its verdict into stdout at host exit code 0 on
this build (see `harmonyos-uninstall-2026-11-08.md` for the recorded shapes).

## Device and build

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Physical device over USB, `hdc shell` as uid 2000 (shell)
- agent-device head `31dfcd012`, built in the contribution worktree, daemon restarted clean
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

Uninstall reports removal, and a host-side `bm dump -n` right after answers
`error: failed to get information and the parameters may be wrong.` — the
record is gone, so the second dump the fix adds agreed with the hardware:

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
  `device` denominator, and the post-uninstall dump verification all ran on
  hardware at a named commit.
- The `wasInstalled: false` branch ran against a genuinely absent record with
  the live-transport probe answering.
- The "record survives bm uninstall" refusal (a `bm` that answers success but
  leaves the bundle) has no hardware reproduction on this build; the unit test
  `uninstall refuses to claim removal when the bundle record survives bm
  uninstall` pins the behavior with the recorded output shapes.
- Local `check:affected --run --head 31dfcd012 --base old-origin/main` passes
  every stage except `unit`; `unit` fails only
  `scripts/__tests__/eager-closure-budgets.test.ts` because this clone's
  `origin` names a private fork, so the gate reads the wrong merge base. With
  `refs/remotes/origin/main` pointed at the upstream head for the duration of
  one `pnpm run check:unit`, that chain exits 0. Both receipts are local; CI on
  the pushed head is the authoritative run.
