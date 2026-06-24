import { defineCommandFamilyFromFacets } from '../family/types.ts';
import { appsCommandFacet, closeCommandFacet, openCommandFacet } from './app.ts';
import { deviceManagementCommandFacets } from './device.ts';
import { installManagementCommandFacets } from './install.ts';
import { prepareCommandFacet } from './prepare.ts';
import { pushManagementCommandFacets } from './push.ts';
import { sessionCommandFacet } from './session.ts';
import { viewportCommandFacet } from './viewport.ts';

export const managementCommandFamily = defineCommandFamilyFromFacets({
  name: 'management',
  commands: [
    ...deviceManagementCommandFacets,
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
