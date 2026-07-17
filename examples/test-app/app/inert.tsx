import { AppFrame } from '../src/components';
import { InertScreen } from '../src/screens/InertScreen';

// Presented as a fullScreenModal (see app/_layout.tsx) rather than pushed: iOS
// detaches the presenting screen once a full-screen present settles, so Settings
// and the tab bar — which carries live badges — leave the hierarchy entirely.
// The retry signature hashes every node on screen, so that matters.
export default function InertRoute() {
  return (
    <AppFrame>
      <InertScreen />
    </AppFrame>
  );
}
