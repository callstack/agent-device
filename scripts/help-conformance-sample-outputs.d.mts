export type CapturedSample = { command: string; output: string };

export declare function sampleText(sample: CapturedSample): string;

export declare const SETTLE_TAIL_SAMPLE: CapturedSample;
export declare const SETTLE_DIFF_SAMPLE: CapturedSample;
export declare const SETTLE_DIFF_SAMPLE_NOTES: CapturedSample;
export declare const NOT_SETTLED_SAMPLE: CapturedSample;
export declare const PRIVATE_AX_RECOVERY_SAMPLE: CapturedSample;
export declare const DEVICE_IN_USE_SAMPLE: CapturedSample;
export declare const STALE_REF_SAMPLE: CapturedSample;
export declare const AMBIGUOUS_MATCH_SAMPLE: CapturedSample;
export declare const APP_NOT_INSTALLED_SAMPLE: CapturedSample;
