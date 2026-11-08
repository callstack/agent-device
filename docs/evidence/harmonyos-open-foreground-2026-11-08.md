# HarmonyOS open foreground verification, 2026-11-08

Evidence for #4293 (verify foreground after open instead of trusting the
launch line): the post-check reads the mission list live after the dispatch
and only then reports the open. On this device `aa dump -l` names the
foreground bundle per mission, which is exactly what the poll consumes.

## Device

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Serial `77TYD26826028730`, USB, `hdc shell` as uid 2000 (shell)

## The poll's data source, live

After `open com.stringzhao.moonwell --activity EntryAbility` through the
branch CLI, the mission list names the launched bundle as the foreground
mission — the same read the poll performs:

```sh
$ hdc -t 77TYD26826028730 shell "aa dump -l"
    Mission ID #45  mission name #[#com.stringzhao.moonwell:entry:EntryAbility] ...
        app name [com.stringzhao.moonwell]
        bundle name [com.stringzhao.moonwell]
        state #FOREGROUND  start time [391219654]
```

The CLI run itself (branch build):

```sh
$ node bin/agent-device.mjs open com.stringzhao.moonwell --platform harmonyos \
    --serial 77TYD26826028730 --activity EntryAbility
Opened: com.stringzhao.moonwell
```

A second run of a slow-starting app (`com.stringzhao.flashcards`, cold start
with its stored data) also reached `state #FOREGROUND` and opened clean.

## The unconfirmed paths, and why they are not reproduced live here

The unconfirmed shape — the launch dispatch accepted while the launched bundle
never holds the foreground — happens under the keyguard (`aa dump -l` keeps
listing missions with none foreground) or when another app keeps stealing the
front. Reproducing the keyguard shape live requires locking this device, whose
unlock PIN this evidence session must not handle; stealing the front raced
against an app that confirmed in ~500 ms. The decision paths are pinned by the
branch's own unit tests instead, all passing:

- `pollHarmonyOpenForeground keeps polling until the launched bundle holds the foreground`
- `pollHarmonyOpenForeground names the app that kept the foreground when the launch never surfaces` — the warning carries `foregroundPackage`
- `pollHarmonyOpenForeground reports an unreadable foreground when no mission is foreground` — the lock-screen shape
- plus the abort and failed-read shapes

`open --foreground` escalates an unconfirmed read to a hard
`open-not-foreground` failure with the same `foregroundPackage` detail; a
plain open attaches the read at `timing.foregroundVerification` beside its
warning.

## Suite

`packages/platform-harmonyos/src/__tests__/app-lifecycle.test.ts`: 89 tests
pass on this branch's build (typecheck and lint clean).
