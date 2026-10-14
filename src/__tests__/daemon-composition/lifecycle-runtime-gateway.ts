import {
  createLifecycleDeviceRuntimeGateway,
  createLifecycleDeviceRuntimeGatewaySpies,
} from '../../daemon/__tests__/test-device-runtime-gateway.ts';
import { composedLifecycleRuntimeFixture } from './application-lifecycle-runtime-fixture.ts';

/**
 * The lifecycle gateway over the REAL composed platform runtime (root gateway + apple/android
 * application tools). Composition suites that pin what the real runtime modules answer bind this;
 * daemon suites bind the canned port fixture instead.
 */
export const realLifecycleDeviceRuntimeGateway = createLifecycleDeviceRuntimeGateway(
  composedLifecycleRuntimeFixture,
);

export const createRealLifecycleDeviceRuntimeGatewaySpies = () =>
  createLifecycleDeviceRuntimeGatewaySpies(composedLifecycleRuntimeFixture);
