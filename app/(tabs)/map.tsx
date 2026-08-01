import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useUserLocation } from '@/hooks/use-user-location';
import { fetchRoadEvents } from '@/lib/road-events';
import type { RoadEvent } from '@/types/road-event';

// Zadar, Croatia. Deltas are tuned to frame the city on first load.
const ZADAR_REGION = {
  latitude: 44.1194,
  longitude: 15.2314,
  latitudeDelta: 0.06,
  longitudeDelta: 0.06,
};

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView>(null);
  const { status: locationStatus, position } = useUserLocation();
  const [events, setEvents] = useState<RoadEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchRoadEvents()
      .then((data) => {
        if (active) setEvents(data);
      })
      .catch(() => {
        if (active) setError('Couldn’t load road events.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Recenter once onto the user when the first fix arrives (no force-follow).
  useEffect(() => {
    if (position) {
      mapRef.current?.animateToRegion(
        {
          latitude: position.latitude,
          longitude: position.longitude,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        },
        800,
      );
    }
  }, [position]);

  const showBanner = loading || error !== null || events.length === 0;

  return (
    <ThemedView style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={ZADAR_REGION}
        showsUserLocation={locationStatus === 'granted'}>
        {events.map((event) => (
          <Marker
            key={event.id}
            coordinate={{ latitude: event.latitude, longitude: event.longitude }}
            title={event.title}
            description={event.description}
          />
        ))}
      </MapView>

      {showBanner && (
        <ThemedView style={[styles.banner, { top: insets.top + 8 }]}>
          {loading && <ActivityIndicator />}
          <ThemedText type="defaultSemiBold">
            {loading ? 'Loading road events…' : (error ?? 'No road events yet')}
          </ThemedText>
        </ThemedView>
      )}

      {locationStatus === 'denied' && (
        <ThemedView style={[styles.banner, { bottom: insets.bottom + 16 }]}>
          <ThemedText type="defaultSemiBold">
            Location off — enable it in Settings to see your position
          </ThemedText>
        </ThemedView>
      )}
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
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
});
