/**
 * The display facts an Apple runner capture reports about the image it encoded (#2728).
 *
 * A foldable lights one panel at a time and the dark panel still answers with a valid all-black PNG
 * at exit zero, so a capture has to carry its own proof of what it looked at: the display it
 * captured, the box it encoded, and how many pixels make one point. Swift owns the encoder
 * (`ScreenshotMetadataPayload` in `RunnerTests+Models.swift`) and this module owns the reader; those
 * two types are the only declarations of the shape. The golden table
 * `contracts/fixtures/screen-capture-metadata.json` carries the wire key and two real measured
 * captures, and each language decodes it through its own production type — this file's test and
 * `UnitTests/RunnerTests+AppScreenCaptureTests.swift` — so a renamed or dropped fact turns both
 * lanes red without a simulator. A consumer may not restate this shape as a local literal or read it
 * through an unchecked cast.
 */

/** The `data` key a runner screenshot result carries its display facts under. */
const RUNNER_SCREEN_CAPTURE_METADATA_KEY = 'screenshotMetadata';

/**
 * What one runner capture measured about itself. `pixelsPerPoint` is the scale of the image the
 * runner encoded, `pixelWidth`/`pixelHeight` are that encoded image's own box after the runner drew
 * it upright, and `displayID` is the screen the window reported — never a screen chosen by number
 * or by position in a screen list.
 */
export type RunnerScreenCaptureMetadata = Readonly<{
  displayID: number;
  pixelWidth: number;
  pixelHeight: number;
  pixelsPerPoint: number;
}>;

/**
 * Reads the display facts out of a runner `data` payload. Returns undefined when the payload carries
 * none or carries a value that cannot describe a real capture, which leaves the consumer with no
 * source fact — the honest pre-panel state — rather than a number invented from a panel nobody
 * measured. The Swift encoder refuses to report a scale that is not finite and positive, so these
 * refusals are the host's defence against a payload that did not come from that encoder.
 */
export function readRunnerScreenCaptureMetadata(
  data: Record<string, unknown>,
): RunnerScreenCaptureMetadata | undefined {
  const raw = data[RUNNER_SCREEN_CAPTURE_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const payload = raw as Record<string, unknown>;
  const displayID = readPositiveInteger(payload.displayID);
  const pixelWidth = readPositiveInteger(payload.pixelWidth);
  const pixelHeight = readPositiveInteger(payload.pixelHeight);
  const pixelsPerPoint = readPositiveFinite(payload.pixelsPerPoint);
  if (
    displayID === undefined ||
    pixelWidth === undefined ||
    pixelHeight === undefined ||
    pixelsPerPoint === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ displayID, pixelWidth, pixelHeight, pixelsPerPoint });
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readPositiveFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
