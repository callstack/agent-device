# Run native replay and test suites

Install `@agent-device/replay` on the daemon host before running native `.ad` scripts or any `test` suite:

```sh
agent-device plugins add @agent-device/replay
```

Finish your sessions, then restart the daemon on that host. Retry your original command with all its arguments. Existing `.ad` syntax, variables, target identity, divergence reports, resume and repair do not need a migration.

The plugin contributes native `.ad` replay and test execution as a version 3 `replay-execution` contribution and supports core `>=0.22.0-0 <0.23.0`. The extraction's pinned development host, `0.21.38-dev`, is also accepted. Other core releases, including the next development bump, fail with `incompatible_plugin` until compatibility is verified and the declared range is updated. The managed API version 3 check also applies: the package declares `"agent-device": { "apiVersion": 3, "replayExecution": true }`, and a package without that field is refused before it is imported. Use matching core and plugin releases. The package remains private until a maintainer publishes a non-`latest` npm placeholder and configures trusted publishing for `.github/workflows/release.yml`, job `npm-publish`.

## Choose the installation host

| Workflow | Client host | Daemon host |
| --- | --- | --- |
| Native `.ad` replay | Core reads and sends the source | `@agent-device/replay` |
| Native `.ad` test suites | Core discovers and sends sources | `@agent-device/replay` |
| Maestro replay | `@agent-device/maestro` collects includes | `@agent-device/maestro` |
| Maestro test suites | `@agent-device/maestro` collects includes | Both plugins |
| `replay export` to Maestro | `@agent-device/maestro` | No daemon required |

Installing locally does not install anything on a remote daemon. Run `plugins add` on each host that needs the package.

## Run replay from JavaScript

Install the plugin with the command above. Start a detached daemon before
creating the client, and use the same state directory for both:

```js
import { createAgentDeviceClient, ensureDaemon } from 'agent-device';

const stateDir = './.my-app/agent-device-state';
await ensureDaemon({ stateDir });
const client = createAgentDeviceClient({ stateDir });
await client.replay.run({ path: './checkout.ad' });
```

## Recover from an unavailable plugin

`plugin-not-installed` includes the exact package and `installCommand`. Install it on the named host, restart that daemon, then retry the original invocation with all its arguments.

`plugin_load_failed`, `invalid_plugin`, `incompatible_plugin` and `plugin_setup_failed` describe a selected package that failed. Repair or update that package; another backend is never selected automatically. `daemon-plugin-set-stale` means the running daemon has an older set than the store. Finish your sessions and restart it. No error installs a package or terminates your sessions automatically.

Ordinary `open --save-script`, `session save-script` and `close` recording remain in core. Replay-specific `--save-script` repair requires this plugin. Core retains sessions, dispatch, selectors, refs, recording, cancellation and cleanup. The plugin receives the existing explicit step and suite ports; shared `.ad` data and divergence readers remain independent of execution.
