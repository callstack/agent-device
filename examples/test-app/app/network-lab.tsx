import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ENDPOINT = 'https://httpbin.org/json';

/**
 * Network lab: deterministic in-app traffic for `network dump` verification.
 * Each press performs one plain `fetch` or `XMLHttpRequest` so a dump can be
 * checked against a request the harness just made.
 */
export default function NetworkLabRoute() {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState('idle');

  const runFetch = async () => {
    setStatus('running');
    try {
      const response = await fetch(ENDPOINT, {
        method: 'GET',
        headers: { 'x-agent-device-lab': 'network', 'x-api-key': 'lab-secret-1' },
      });
      const body = await response.text();
      setStatus(`fetch:${response.status}:${body.length}`);
    } catch (error) {
      setStatus(`fetch:error:${(error as Error).message}`);
    }
  };

  /**
   * One failed fetch followed by a direct XHR to the same URL. The capture must report both:
   * the failed fetch's claim on the URL must not hide the XHR that comes after it.
   */
  const runFailedFetchThenXhr = async () => {
    setStatus('running');
    const url = 'https://invalid.agent-device.test/after-failed-fetch';
    try {
      await fetch(url);
    } catch {
      // The failure is the fixture; the XHR below is what the dump must still name.
    }
    const request = new XMLHttpRequest();
    request.open('GET', url);
    request.onload = () => setStatus(`xhr-after-failed-fetch:${request.status}`);
    request.onerror = () => setStatus(`xhr-after-failed-fetch:failed:${request.status}`);
    request.send();
  };

  const runPost = async () => {
    setStatus('running');
    try {
      const response = await fetch('https://httpbin.org/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lab: 'network', seq: 1 }),
      });
      setStatus(`post:${response.status}`);
    } catch (error) {
      setStatus(`post:error:${(error as Error).message}`);
    }
  };

  const runXhr = () => {
    setStatus('running');
    const request = new XMLHttpRequest();
    request.open('GET', 'https://httpbin.org/get?xhr=1');
    request.onload = () => setStatus(`xhr:${request.status}`);
    request.onerror = () => setStatus('xhr:error');
    request.send();
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
      style={{ flex: 1 }}
      testID="network-lab"
    >
      <Text testID="network-lab-title">Network lab</Text>
      <Pressable onPress={() => void runFetch()} style={styles.button} testID="network-fetch">
        <Text>Run fetch</Text>
      </Pressable>
      <Pressable onPress={() => void runPost()} style={styles.button} testID="network-post">
        <Text>Run post</Text>
      </Pressable>
      <Pressable onPress={runXhr} style={styles.button} testID="network-xhr">
        <Text>Run XHR</Text>
      </Pressable>
      <Pressable
        onPress={() => void runFailedFetchThenXhr()}
        style={styles.button}
        testID="network-failed-fetch-xhr"
      >
        <Text>Run failed fetch then XHR</Text>
      </Pressable>
      <View>
        <Text testID="network-lab-status">{status}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  button: { paddingVertical: 12 },
});
