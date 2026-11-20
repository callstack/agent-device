import { describe, it, expect } from '@ohos/hypium';
import { Driver, PointerMatrix } from '@ohos.UiTest';
import type { Point } from '@ohos.UiTest';
import { hilog } from '@kit.PerformanceAnalysisKit';
import abilityDelegatorRegistry from '@ohos.app.ability.abilityDelegatorRegistry';

const TAG = 'AdTrajDriver';
const HILOG_DOMAIN = 0x0000;
const RESULT_PREFIX = 'ADTRAJ_RESULT ';
const MIN_SPEED_PX_PER_S = 200;
const MAX_SPEED_PX_PER_S = 40000;
const MIN_STEPS = 2;
const MAX_STEPS = 1000;

interface TrajectoryStep {
  x: number;
  y: number;
}

interface InjectionRequest {
  speed: number;
  steps: TrajectoryStep[];
}

interface InjectionOutcome {
  ok: boolean;
  sampleCount: number;
  speed: number;
  error: string;
}

/**
 * The carrier case: one `-s traj <json>` parameter drives one multi-point pointer injection
 * through the platform test API. agent-device renders the trajectory and the pacing speed; this
 * case validates, injects, reports the outcome on hilog, and asserts acceptance for the runner.
 */
export default function trajSuite(): void {
  describe('adtraj', () => {
    it('injectTrajectory', 0, async () => {
      const parameters = abilityDelegatorRegistry.getArguments().parameters;
      // The delegator keeps every `-s <key> <value>` pair under the literal `"-s <key>"` key.
      const raw = parameters['-s traj'];
      let outcome: InjectionOutcome;
      if (raw === undefined || raw.length === 0) {
        outcome = { ok: false, sampleCount: 0, speed: 0, error: 'missing traj parameter' };
      } else {
        outcome = await injectTrajectory(raw);
      }
      hilog.info(HILOG_DOMAIN, TAG, `${RESULT_PREFIX}${JSON.stringify(outcome)}`);
      expect(outcome.ok).assertTrue();
    });
  });
}

async function injectTrajectory(raw: string): Promise<InjectionOutcome> {
  let request: InjectionRequest;
  try {
    request = parseRequest(raw);
  } catch (error) {
    return { ok: false, sampleCount: 0, speed: 0, error: `parse failed: ${(error as Error).message}` };
  }
  const matrix = PointerMatrix.create(1, request.steps.length);
  hilog.info(HILOG_DOMAIN, TAG, `matrix created: %{public}s`, matrix === null ? 'NULL' : 'ok');
  for (let step = 0; step < request.steps.length; step += 1) {
    const point: Point = { x: request.steps[step].x, y: request.steps[step].y };
    matrix.setPoint(0, step, point);
  }
  const driver = Driver.create();
  const started = Date.now();
  try {
    const accepted = await driver.injectMultiPointerAction(matrix, request.speed);
    const elapsedMs = Date.now() - started;
    if (!accepted) {
      return {
        ok: false,
        sampleCount: request.steps.length,
        speed: request.speed,
        error: 'injectMultiPointerAction returned false',
      };
    }
    // Hold the harness foreground briefly so the host-side screenshot catches the canvas echo.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 3000);
    });
    return {
      ok: true,
      sampleCount: request.steps.length,
      speed: request.speed,
      error: `elapsed ${elapsedMs}ms`,
    };
  } catch (error) {
    const businessError = error as Error;
    return {
      ok: false,
      sampleCount: request.steps.length,
      speed: request.speed,
      error: `inject failed: ${businessError.message}`,
    };
  }
}

function parseRequest(raw: string): InjectionRequest {
  const parsed = JSON.parse(raw) as Record<string, Object>;
  const steps = parsed.steps as TrajectoryStep[];
  if (!Array.isArray(steps) || steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    throw new Error(`steps must hold ${MIN_STEPS}..${MAX_STEPS} points`);
  }
  const speedValue = typeof parsed.speed === 'number' ? parsed.speed : MIN_SPEED_PX_PER_S;
  const speed = Math.min(Math.max(Math.round(speedValue), MIN_SPEED_PX_PER_S), MAX_SPEED_PX_PER_S);
  for (const step of steps) {
    if (typeof step.x !== 'number' || typeof step.y !== 'number' ||
      !Number.isFinite(step.x) || !Number.isFinite(step.y)) {
      throw new Error('every step needs finite x and y');
    }
  }
  return { speed, steps };
}
