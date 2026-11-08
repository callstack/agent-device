# HarmonyOS bm uninstall and dump output shapes, 2026-11-08

Evidence for #4292 (app uninstall beside deploy): the `bm` tool answers failures
in its stdout streams while the host exit code stays 0, so exit-code checks
cannot separate a hit from a miss. The deployment code keys on stream content.

## Device

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Serial `77TYD26826028730`, connected over USB, `hdc shell` runs as uid 2000 (shell)
- Target bundle: `com.stringzhao.adtrajdriver` — a debug-signed harness app
  installed by this contribution's own tooling; no user data involved.

## Reproduce

```sh
hdc -t 77TYD26826028730 shell "bm dump -n com.stringzhao.adtrajdriver"
hdc -t 77TYD26826028730 shell "bm uninstall -n com.stringzhao.adtrajdriver"
hdc -t 77TYD26826028730 shell "bm dump -n com.stringzhao.adtrajdriver"
hdc -t 77TYD26826028730 shell "bm dump -n com.example.never.existed"
```

## Observed output (verbatim)

Installed bundle answers with the metadata JSON:

```
com.stringzhao.adtrajdriver:
{
    "appId": "com.stringzhao.adtrajdriver_BHtJYhGmwNtKN7KMQnFHY8khKgdXmdNKbe3N5bkmfXFjSTg3H4tb/O8xEaRDdKefwIq4tITqX7CwkDr0nwBTAfo=",
    "appIdentifier": "6917620879642277987",
    "appIndex": 0,
    ...
```

Uninstall reports success in stdout, host exit code 0:

```
uninstall bundle successfully.
```

After the uninstall — and for a bundle that never existed — `bm dump` prints
the failure into stdout while the host exit code stays 0:

```
error: failed to get information and the parameters may be wrong.
```

## Consequences for the code

`bm dump` misses and `bm` failures carry their verdict in stdout text at exit
code 0 on this build (7.0.0.111). `install`/`uninstall` success detection keys
on stream content; an exit-code check would read every failure as success.
