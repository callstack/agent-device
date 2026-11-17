import { useLocalSearchParams } from 'expo-router';

import { SettleLabResultScreen } from '../src/screens/SettleLabScreen';

export default function SettleLabResultRoute() {
  const { run } = useLocalSearchParams<{ run?: string }>();
  return <SettleLabResultScreen run={run} />;
}
