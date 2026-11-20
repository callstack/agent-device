# Web Backend

The `@agent-device/web` plugin uses managed `agent-browser`.

- Before web automation, run `agent-device plugins add @agent-device/web`.
- To install the backend in the state directory, run `agent-device web setup`.
- To check the backend, run `agent-device web doctor`.
- Runtime web commands use `tools/agent-browser/<version>` in the state directory.
- Only `web setup` installs the backend.
- If the backend is absent, return the setup hint.
- Use `runManagedAgentBrowser` to run the package's declared JavaScript entry with the current Node runtime.
- Do not use the `node_modules/.bin` shim.

Do not expose direct `agent-browser` commands.
Use `web network dump` to adapt `agent-browser network requests` to agent-device network evidence.
Keep these operations out of the web surface:

- Browser-specific network routing/interception/HAR.
- CDP.
- React web.
- Tabs.
- Downloads.
- Auth vaults.
- Profiling.
