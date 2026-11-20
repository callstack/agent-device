# Web Backend

The `@agent-device/web` plugin provides web automation through a managed `agent-browser` backend.

- Runtime web commands resolve the backend only from the state-dir managed install at `tools/agent-browser/<version>`.
- Normal `--platform web` commands do not install the managed backend on first use.
  If the backend is missing, they fail with a setup hint.
- Before first web automation, install the plugin with `agent-device plugins add @agent-device/web`.
- After you install the plugin, run `agent-device web setup` for the state directory you will use.
- To run the backend health check, use `agent-device web doctor`.
- Each backend call spawns the package's declared `bin` entry with the current Node runtime.
  It never spawns the `node_modules/.bin` console shim.
  A shell would reintroduce hazards from argument quoting.
  Only `runManagedAgentBrowser` executes the backend.

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
