# The zh-Hans physical-iPhone alert runs for the device vocabulary, on the iPhone 12 Pro Max, 2026-11-24

Live evidence for #4859's device-side ask: the three system prompts' `alert get`
labels verbatim, each prompt's `alert accept`/`alert dismiss` outcome, and the
authorization read-backs. Device: iPhone 12 Pro Max (iPhone13,4), iOS 18.1,
Simplified Chinese preferred (Safari and the system prompts render in zh_CN),
USB UDID `00008101-001E34993A7A001E`. Head `3ad0a510f` (the PR's code head) for
the first three runs; the ATT row's cross-version fix run at the working tree
with both wordings. Runs through `node bin/agent-device.mjs` after `pnpm build`,
the runner built with `xcodebuild ... CODE_SIGN_STYLE=Manual
DEVELOPMENT_TEAM=Q7ABCJT625 CODE_SIGN_IDENTITY="Apple Development"
PROVISIONING_PROFILE_SPECIFIER=runner-manual-dev` and installed with
`devicectl device install app`; a purpose-built probe app
(`cc.strzhao.AD4859Probe`, buttons 通知授权/定位授权/追踪授权) triggers the real
system prompts; a status label mirrors the app-side authorization callbacks
(denied / authorizedWhenInUse / denied) as the read-back.

## 1. Notification prompt (head 3ad0a510f)

```
$ agent-device press @e4        # the probe's 通知授权 button
$ agent-device alert get --json
{ "items": ["允许", "在定时推送摘要中允许", "不允许"],
  "message": "“AD4859Probe”想给你发送通知" }
$ agent-device alert dismiss --json
{ "success": true, "message": "dismissed" }   # taps 不允许
# probe status label afterwards: 通知授权 denied
```

## 2. Location prompt (head 3ad0a510f)

```
$ agent-device press @e6        # 定位授权
$ agent-device alert get --json
{ "items": ["允许一次", "使用App时允许", "不允许", "精确位置：打开"],
  "message": "允许“AD4859Probe”使用你的位置？" }
$ agent-device alert accept --json
{ "success": true, "message": "accepted" }    # taps 使用App时允许 (lasting grant)
# probe status label afterwards: 定位授权 authorizedWhenInUse
```

The buttons match the zh_CN `locationd` strings the simulator read pinned
(`使用App时允许` / `允许一次` / `不允许`); the device ships no 仅在使用期间允许 /
仅本次允许 forms.

## 3. ATT prompt (head 3ad0a510f) — and the cross-version wording it exposed

```
$ agent-device press @e8        # 追踪授权
$ agent-device alert get --json
{ "items": ["要求App不跟踪", "允许"],
  "message": "允许“AD4859Probe”跟踪你在其他公司的App和网站上的活动吗？" }
$ agent-device alert dismiss --json
→ ALERT_BUTTON_NOT_FOUND: the table's row was 要求App不追踪 (追踪), which no
  device button matches; nothing tapped.
# probe status label: 追踪授权 denied was NOT reached this way — the prompt was
# dismissed manually, the app reinstalled to reset the TCC decision, and the
# run repeated after the fix.
```

The device words the decline button 要求App不**跟踪**, iOS 26.5–27.x's zh_CN
ships 要求App不**追踪** (TCC `REQUEST_ACCESS_DENY_kTCCServiceUserTracking`, read
off the CoreSimulator runtime images): a version split no single-runtime
`fromSystemStrings` read can see. The table now carries both rows.

After the fix (table carries both wordings, same head otherwise):

```
$ agent-device press @e8
$ agent-device alert get --json
{ "items": ["要求App不跟踪", "允许"], … }
$ agent-device alert dismiss --json
{ "success": true, "message": "dismissed" }   # taps 要求App不跟踪
# probe status label afterwards: 追踪授权 denied
```

## The device cannot read the OS string bundles (the table's premise, verified)

A probe reading `Bundle(path:)` for the three prompt tables on this device
answers `bundle=ok` for every path, but `localizedString(forKey:)` returns the
key itself (`REQUEST_ACCESS_DENY_kTCCServiceUserTracking` → the key, not
要求App不跟踪): the string tables are present but their localizations are not
readable to an app on device. Widening the OS-string read to `os(iOS)` (the
review's optional suggestion) would not work; the built-in table stays.
