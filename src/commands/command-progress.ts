import type { CommandProgressState } from '@agent-device/command-output';
import type {
  CommandProgressEvent,
  RequestProgressEvent,
  RequestProgressSink,
} from '@agent-device/contracts/progress';
import { escapeTerminalText } from '@agent-device/kernel/redaction';
import type { EnvMap } from '@agent-device/kernel/source-value';

type ColorMarker = (marker: NonNullable<CommandProgressEvent['marker']>, line: string) => string;

export function createCommandProgressState(): CommandProgressState {
  return { renderedToStderr: false };
}

/**
 * The CLI's own progress sink: `command` progress lines go to stderr as they
 * arrive, and `state` records that they did. Other event types belong to their
 * own reporters (replay-test) and are not rendered here. With `env`, a line's
 * status marker is colored when this terminal colors status markers.
 */
export function createStderrCommandProgressSink(
  state: CommandProgressState,
  env?: EnvMap,
): RequestProgressSink {
  let colorMarker: ColorMarker | undefined;
  // Loaded as the sink is created, so the status-marker module stays out of every command's startup. It lands long
  // before a daemon's first marked line; a line that came first would just stay plain.
  if (env) {
    void loadStatusMarkerColor(env).then((color) => {
      colorMarker = color;
    });
  }
  return (event: RequestProgressEvent) => {
    if (event.type !== 'command') return;
    state.renderedToStderr = true;
    // Escaped like every CLI write, since a progress message can name a value a device chose; only the marker
    // color added afterwards reaches the terminal as a control code.
    const line = escapeTerminalText(event.message);
    const shown = event.marker && colorMarker ? colorMarker(event.marker, line) : line;
    process.stderr.write(`${shown}\n`);
  };
}

/**
 * Colors the plain status marker an escaped line starts with, when status markers are colored for this terminal;
 * otherwise the line is returned as is.
 */
async function loadStatusMarkerColor(env: EnvMap): Promise<ColorMarker> {
  const { formatCliStatusMarker, shouldColorStatusMarkers } =
    await import('@agent-device/host-kit/status-markers');
  if (!shouldColorStatusMarkers(env, Boolean(process.stderr.isTTY))) return (_marker, line) => line;
  return (marker, line) => {
    const plain = formatCliStatusMarker(marker, { useColor: false });
    return line.startsWith(plain)
      ? `${formatCliStatusMarker(marker, { useColor: true })}${line.slice(plain.length)}`
      : line;
  };
}
