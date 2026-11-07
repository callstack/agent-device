# HarmonyOS uninstall transport classification, 2026-11-07

Source under review: `forge/harmony-uninstall` at `7c0be71b5f7ee40101d9637d438f364114338dc6`.
The classification fix landed as a follow-up commit on the same branch.
Device: physical HarmonyOS handset, hdc serial `77TYD26826028730`.
hdc: local command-line tools at `~/.local/harmony/command-line-tools/sdk/default/openharmony/toolchains/hdc`.
Purpose: record the observable `bm dump -n` shapes that decide how the uninstall probe separates an absent bundle from a dead transport.

## Observed shapes

Every command ran as `hdc -t <serial> shell <words>`. Exit codes below are host-side.

| Probe | Host exit | stdout |
| --- | --- | --- |
| `bm dump -n <installed bundle>` | 0 | `<bundle>:` line, then the JSON record |
| `bm dump -n com.agentdevice.probe.absent` | 0 | `error: failed to get information and the parameters may be wrong.`, no JSON |
| `bm uninstall -n com.agentdevice.probe.absent` | 0 | `error: failed to uninstall bundle.` plus failure code `9568386` |
| `bm dump -n <installed bundle>` through a bogus serial | 0 | `[Fail]Not match target founded, check connect-key please` |
| `shell true` on the connected target | 0 | empty |
| `shell true` through the bogus serial | 0 | `[Fail]Not match target founded, check connect-key please` |

The installed-bundle record proves the `bm dump -n <bundle>` JSON extraction used by both deploy and uninstall.
The absent-bundle row proves bm answers a missing bundle with an error record while exiting zero.
The bogus-serial rows prove this hdc build reports an unreachable target through stdout while exiting zero.
Exit codes alone cannot separate "bm answered absent" from "hdc never reached the target" on this hardware.
The runtime therefore classifies an absent record with a `shell true` probe, and it throws `COMMAND_FAILED` when the probe shows no live transport.

## Coverage gaps

The removal itself was not executed on this device. Every installed bundle belongs to the device owner, and the repository ships no HarmonyOS fixture HAP. Installing the example test app only to capture one uninstall transcript was out of scope for this review fix. The absent-record path and the dead-transport path carry mocked tests in `packages/platform-harmonyos/src/deployment/runtime.test.ts`, and the mocked transport shapes above come from this run.
