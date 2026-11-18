# Web Backend

Web automation uses a managed `agent-browser` backend as an implementation detail.

- Runtime web commands resolve the backend only from the state-dir managed install at `tools/agent-browser/<version>`.
- Normal `--platform web` commands do not install the managed backend on first use.
  If the backend is missing, they fail with a setup hint.
- Before first web automation or in CI/sandbox bootstrap steps, use `agent-device web setup`.
- To run the backend health check, use `agent-device web doctor`.
- Only `runManagedAgentBrowser` executes the backend.
  It spawns the declared `bin` entry with the current Node runtime, never the `.bin` shim.

Do not document direct `agent-browser` commands as agent-device features.
Web `network dump` is the narrow exception.
It adapts `agent-browser network requests` to the existing agent-device network evidence shape.
Until an explicit agent-device command design exists for them, exclude these features from the minimal web surface:

- Browser-specific network routing/interception/HAR.
- CDP.
- React web.
- Tabs.
- Downloads.
- Auth vaults.
- Profiling.
