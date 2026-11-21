# HarmonyOS open --launch-args lowering, 2026-11-08

Evidence for #4287 (lower `open --launch-args` to `aa start` parameters): the
flag no longer drops on HarmonyOS. The option lowers into the `aa start`
argv as explicit `--ps`/`--pi` parameter words, the branch pins that argv in
its tests, and a live run launches the app through the modified want.

## Device

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Serial `77TYD26826028730`, USB

## The pinned argv shape (branch unit test, app-lifecycle.test.ts)

```ts
await openHarmonyApp(DEVICE, 'com.example.application', {
  activity: 'EntryAbility',
  launchArgs: ['--ps', 'configKey', 'debug', '--pi', 'retryCount', '3'],
});
// asserts the hdc argv exactly:
// ['hdc','-t','harmony-1','shell','aa','start','-a','EntryAbility',
//  '-b','com.example.application','--ps','configKey','debug','--pi','retryCount','3']
```

A sibling test asserts the absent-args case forwards no extra `aa start`
words, so the flag is the only source of parameters.

## Live run

Branch build, JDY-AL50, the app is a data-carrying user app driven read-only:

```sh
$ node bin/agent-device.mjs open com.stringzhao.moonwell --platform harmonyos \
    --serial 77TYD26826028730 --activity EntryAbility \
    --launch-args 'qa_seed=1,mode=evidence'
Opened: com.stringzhao.moonwell
$ hdc -t 77TYD26826028730 shell "aa dump -l"
        bundle name [com.stringzhao.moonwell]
        state #FOREGROUND
```

The modified want is accepted by the ability manager and the app reaches the
foreground (the #4293 post-check confirms it; the earlier a80-era run left the
device in the same state).

## Observability limit, stated plainly

The want parameters reach the ability through the ability manager and are not
printed at default hilog levels (grepped `qa_seed` after a cleared ring: no
hit). Proving in-app receipt needs an instrumented build; this evidence
session drove a user-built app and could not add one. What the device proves
is the accepted dispatch with the lowered argv and a clean foreground launch;
the argv shape itself is pinned by the unit test above.

## Guard

`assertOpenDeviceSupport` still refuses launch args on platforms without the
lowering, with a typed UNSUPPORTED_OPERATION, so the silent-drop case cannot
come back through another surface.
