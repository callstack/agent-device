# Simulator helper readiness

Binary preparation and helper startup share a capture's 2-second readiness allowance.
The original capture deadline also bounds this allowance.
If startup remains pending, the source returns typed `preparing`.
The route can serve that capture through its existing fallback.
A later capture can use the prepared helper with its original request deadline.

The source owns one detached startup attempt per Simulator and binary path.
Startup has a 10-second ceiling.
The ceiling allows that cold launch and framework initialization to finish.
It does not extend a capture deadline.
A caller abort ends only its readiness wait.
Source close aborts startup, adopts asynchronous creation, and awaits resource cleanup.
Actual native requests remain serialized per Simulator.

The native helper initializes its framework runtime before binding its listener.
Readiness does not create a target root or change automation settings.
Target identity, foreground ownership, envelope validation, and capture limits still apply to requests.
Readiness does not prove that an app's accessibility server can answer a capture.

Behavioral checks are in `lifecycle.test.ts` and `cache-native-runtime.test.ts`.
Run them through the Vitest `unit-core` project.
