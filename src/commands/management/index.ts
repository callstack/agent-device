import { defineCommandFamilyFromFacets } from '../family/types.ts';
import { artifactsCommandFacet } from './artifacts.ts';
import { appsCommandFacet, closeCommandFacet, openCommandFacet } from './app.ts';
import { deviceManagementCommandFacets } from './device.ts';
import { doctorCommandFacet } from './doctor.ts';
import { installManagementCommandFacets } from './install.ts';
import { prepareCommandFacet } from './prepare.ts';
import { pushManagementCommandFacets } from './push.ts';
import { sessionCommandFacet } from './session.ts';
import { viewportCommandFacet } from './viewport.ts';

export const managementCommandFamily = defineCommandFamilyFromFacets({
  name: 'management',
  commands: [
    ...deviceManagementCommandFacets,
    artifactsCommandFacet,
    doctorCommandFacet,
    prepareCommandFacet,
    appsCommandFacet,
    sessionCommandFacet,
    openCommandFacet,
    closeCommandFacet,
    viewportCommandFacet,
    ...installManagementCommandFacets,
    ...pushManagementCommandFacets,
  ],
});
