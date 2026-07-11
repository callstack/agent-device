import { AppError } from '../../kernel/errors.ts';
import type { MaestroObservation } from './engine-types.ts';

export class MaestroExecutionContext {
  readonly overrides: Readonly<Record<string, string>>;
  #values: Record<string, string>;
  #generation = 0;
  #observation: MaestroObservation | undefined;

  constructor(
    defaults: Record<string, string | number | boolean> = {},
    overrides: Record<string, string> = {},
  ) {
    this.overrides = { ...overrides };
    this.#values = { ...stringifyValues(defaults), ...overrides };
  }

  get values(): Readonly<Record<string, string>> {
    return this.#values;
  }

  get generation(): number {
    return this.#generation;
  }

  get observation(): MaestroObservation | undefined {
    return this.#observation?.generation === this.#generation ? this.#observation : undefined;
  }

  enter(values: Record<string, string | number | boolean> = {}): () => void {
    const previous = this.#values;
    this.#values = { ...previous, ...stringifyValues(values), ...this.overrides };
    return () => {
      this.#values = previous;
    };
  }

  merge(values: Record<string, string>): void {
    this.#values = { ...this.#values, ...values, ...this.overrides };
  }

  recordObservation(observation: MaestroObservation): void {
    if (observation.generation !== this.#generation) {
      throw new AppError(
        'COMMAND_FAILED',
        `Maestro observation generation ${observation.generation} does not match ${this.#generation}.`,
      );
    }
    this.#observation = observation;
  }

  recordMutation(): void {
    this.#generation += 1;
    this.#observation = undefined;
  }

  resolve(value: string): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (match, key: string) =>
      Object.hasOwn(this.#values, key) ? this.#values[key]! : match,
    );
  }
}

function stringifyValues(
  values: Record<string, string | number | boolean>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
}
