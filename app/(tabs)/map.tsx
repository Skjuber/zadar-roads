import { FirebaseError } from 'firebase/app';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import MapView, { Marker, type LatLng, type LongPressEvent, type MarkerDragStartEndEvent } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useUserLocation } from '@/hooks/use-user-location';
import { fetchRoadEvents, submitDraftReport } from '@/lib/road-events';
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
  // Candidate location for a new user report, captured by long-pressing the map.
  // Independent of events/location state; the report form (Move 2) will read it.
  const [draft, setDraft] = useState<LatLng | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Long press is the deliberate "drop a pin here" gesture (Google Maps convention),
  // so a stray tap won't create a report. Whether a long press on an existing marker
  // falls through to the map is expected-but-untested — not verified against the docs.
  const handleMapLongPress = (e: LongPressEvent) => setDraft(e.nativeEvent.coordinate);
  const handleDraftDragEnd = (e: MarkerDragStartEndEvent) => setDraft(e.nativeEvent.coordinate);

  const handleSubmit = async () => {
    if (!draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitDraftReport(draft);
      setDraft(null);
      const data = await fetchRoadEvents(); // refetch so the newly written pin appears
      setEvents(data);
    } catch (err) {
      // Surface the raw failure — especially Firestore's `permission-denied` code —
      // instead of failing silently, so a rejected document shape is visible on screen.
      const code = err instanceof FirebaseError ? err.code : null;
      setSubmitError(code ?? (err instanceof Error ? err.message : 'Submit failed'));
    } finally {
      setSubmitting(false);
    }
  };

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

  // Stack the Cancel pill above the "Location off" bottom pill when both show, so they
  // never overlap; otherwise it sits at the normal bottom position. The top status pill
  // lives at the top edge, so there's no collision there either.
  const cancelBottom = insets.bottom + 16 + (locationStatus === 'denied' ? 56 : 0);
  // Submit-error pill sits one row above the draft pill so it never overlaps it.
  const submitErrorBottom = cancelBottom + 56;

  return (
    <ThemedView style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={ZADAR_REGION}
        showsUserLocation={locationStatus === 'granted'}
        onLongPress={handleMapLongPress}>
        {events.map((event) => (
          <Marker
            key={event.id}
            coordinate={{ latitude: event.latitude, longitude: event.longitude }}
            title={event.title}
            description={event.description}
          />
        ))}
        {draft && (
          <Marker
            coordinate={draft}
            pinColor="orange"
            title="New report"
            draggable
            onDragEnd={handleDraftDragEnd}
          />
        )}
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

      {submitError && (
        <ThemedView style={[styles.banner, { bottom: submitErrorBottom }]}>
          <ThemedText type="defaultSemiBold">Submit failed: {submitError}</ThemedText>
        </ThemedView>
      )}

      {draft && (
        <ThemedView style={[styles.banner, { bottom: cancelBottom }]}>
          {submitting && <ActivityIndicator />}
          <ThemedText type="defaultSemiBold">Report location set</ThemedText>
          <Pressable onPress={handleSubmit} disabled={submitting} hitSlop={8}>
            <ThemedText type="link">Submit</ThemedText>
          </Pressable>
          <Pressable
            onPress={() => {
              setDraft(null);
              setSubmitError(null);
            }}
            disabled={submitting}
            hitSlop={8}>
            <ThemedText type="link">Cancel</ThemedText>
          </Pressable>
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
