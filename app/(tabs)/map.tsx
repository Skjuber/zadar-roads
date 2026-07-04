import { StyleSheet } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import { ThemedView } from '@/components/themed-view';

// Zadar, Croatia. Deltas are tuned to frame the city on first load.
const ZADAR_REGION = {
  latitude: 44.1194,
  longitude: 15.2314,
  latitudeDelta: 0.06,
  longitudeDelta: 0.06,
};

// Hard-coded placeholder to prove the marker pipeline renders end-to-end
// before wiring pins to Firestore. Swap for real RoadEvent data later.
const TEST_EVENT = {
  latitude: 44.1194,
  longitude: 15.2314,
};

export default function MapScreen() {
  return (
    <ThemedView style={styles.container}>
      <MapView style={styles.map} initialRegion={ZADAR_REGION}>
        <Marker
          coordinate={TEST_EVENT}
          title="Test construction site"
          description="Hard-coded marker — placeholder for a real RoadEvent"
        />
      </MapView>
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
