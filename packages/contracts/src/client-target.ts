// The public API vocabulary for how a client names the element an interaction acts on.

export type PointTarget = {
  x: number;
  y: number;
  ref?: never;
  selector?: never;
  label?: never;
};

export type RefTarget = {
  ref: string;
  label?: string;
  x?: never;
  y?: never;
  selector?: never;
};

export type SelectorTarget = {
  selector: string;
  x?: never;
  y?: never;
  ref?: never;
  label?: never;
};

export type InteractionTarget = PointTarget | RefTarget | SelectorTarget;

export type ElementTarget = RefTarget | SelectorTarget;
