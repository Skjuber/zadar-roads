import { StyleSheet } from 'react-native';
import MapView from 'react-native-maps';

import { ThemedView } from '@/components/themed-view';

// Zadar, Croatia. Deltas are tuned to frame the city on first load.
const ZADAR_REGION = {
  latitude: 44.1194,
  longitude: 15.2314,
  latitudeDelta: 0.06,
  longitudeDelta: 0.06,
};

export default function MapScreen() {
  return (
    <ThemedView style={styles.container}>
      <MapView style={styles.map} initialRegion={ZADAR_REGION} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
});
