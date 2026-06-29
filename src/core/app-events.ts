import type { DeviceInfo } from '../kernel/device.ts';
import { AppError } from '../kernel/errors.ts';

const APP_EVENT_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_APP_EVENT_PAYLOAD_BYTES = 8 * 1024;
const MAX_APP_EVENT_URL_LENGTH = 4 * 1024;

type AppEventPayload = Record<string, unknown> | undefined;

export function parseTriggerAppEventArgs(positionals: string[]): {
  eventName: string;
  payload: AppEventPayload;
} {
  const eventName = positionals[0]?.trim();
  const payloadArg = positionals[1]?.trim();
  if (!eventName) {
    throw new AppError('INVALID_ARGS', 'trigger-app-event requires <event> [payloadJson]');
  }
  if (!APP_EVENT_NAME_PATTERN.test(eventName)) {
    throw new AppError('INVALID_ARGS', `Invalid trigger-app-event event name: ${eventName}`, {
      hint: 'Use 1-64 chars: letters, numbers, underscore, dot, colon, or dash.',
    });
  }
  if (positionals.length > 2) {
    throw new AppError(
      'INVALID_ARGS',
      'trigger-app-event accepts at most two arguments: <event> [payloadJson]',
    );
  }
  const payload = parseTriggerEventPayload(payloadArg, eventName);
  return { eventName, payload };
}

export function resolveAppEventUrl(
  platform: DeviceInfo['platform'],
  eventName: string,
  payload?: AppEventPayload,
): string {
  const template = readAppEventUrlTemplate(platform);
  if (!template) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `No app event URL template configured for ${platform}.`,
      {
        hint: `Set AGENT_DEVICE_${platform.toUpperCase()}_APP_EVENT_URL_TEMPLATE or AGENT_DEVICE_APP_EVENT_URL_TEMPLATE, for example "myapp://agent-device/event?name={event}&payload={payload}".`,
      },
    );
  }

  const payloadText = payload ? JSON.stringify(payload) : '';
  const eventUrl = template
    .replaceAll('{event}', encodeURIComponent(eventName))
    .replaceAll('{payload}', encodeURIComponent(payloadText))
    .replaceAll('{platform}', encodeURIComponent(platform));
  if (eventUrl.length > MAX_APP_EVENT_URL_LENGTH) {
    throw new AppError('INVALID_ARGS', 'trigger-app-event URL exceeds maximum supported length', {
      hint: 'Reduce payload size or shorten AGENT_DEVICE_*_APP_EVENT_URL_TEMPLATE.',
      length: eventUrl.length,
      maxLength: MAX_APP_EVENT_URL_LENGTH,
    });
  }
  return eventUrl;
}

function parseTriggerEventPayload(
  payloadArg: string | undefined,
  eventName: string,
): AppEventPayload {
  if (!payloadArg) return undefined;
  try {
    const parsed = JSON.parse(payloadArg) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError(
        'INVALID_ARGS',
        `trigger-app-event payload for "${eventName}" must be a JSON object`,
      );
    }
    const payloadText = JSON.stringify(parsed);
    if (Buffer.byteLength(payloadText, 'utf8') > MAX_APP_EVENT_PAYLOAD_BYTES) {
      throw new AppError(
        'INVALID_ARGS',
        `trigger-app-event payload for "${eventName}" exceeds ${MAX_APP_EVENT_PAYLOAD_BYTES} bytes`,
      );
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_ARGS', `Invalid trigger-app-event payload JSON: ${payloadArg}`);
  }
}

function readAppEventUrlTemplate(platform: DeviceInfo['platform']): string | undefined {
  const platformSpecific =
    platform === 'ios'
      ? process.env.AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE
      : platform === 'macos'
        ? process.env.AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE
        : process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
  const candidate = platformSpecific ?? process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
  const trimmed = candidate?.trim();
  return trimmed ? trimmed : undefined;
}
