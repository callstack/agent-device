import { useLocalSearchParams } from 'expo-router';

import { isPerfScenario, PerfLabScreen } from '../src/screens/PerfLabScreen';

export default function PerfLabRoute() {
  const { scenario } = useLocalSearchParams<{ scenario?: string }>();
  const initialScenario = isPerfScenario(scenario) ? scenario : undefined;
  return <PerfLabScreen initialScenario={initialScenario} key={initialScenario} />;
}
