import { FirebaseError } from 'firebase/app';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import MapView, { Marker, type LatLng, type LongPressEvent, type MarkerDragStartEndEvent } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useUserLocation } from '@/hooks/use-user-location';
import { submitDraftReport, subscribeToActiveRoadEvents } from '@/lib/road-events';
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
  // Independent of events/location state; the report form will read it.
  const [draft, setDraft] = useState<LatLng | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  // Long press is the deliberate "drop a pin here" gesture (Google Maps convention),
  // so a stray tap won't create a report. Verified on a physical iPhone: a long press on an
  // existing marker DOES fall through to the map and drop a draft pin — accepted deliberately.
  const handleMapLongPress = (e: LongPressEvent) => setDraft(e.nativeEvent.coordinate);
  const handleDraftDragEnd = (e: MarkerDragStartEndEvent) => setDraft(e.nativeEvent.coordinate);

  const handleSubmit = async () => {
    if (!draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitDraftReport(draft);
      setDraft(null);
      // No refetch: the report is written `pending`, and once the map filters to
      // status=='active' it shouldn't appear here anyway. Just confirm the write.
      setConfirmation('Report submitted — pending review');
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
    // Live subscription: the first callback provides the initial data (replacing the old
    // one-time fetch) and every later change (e.g. an approval flipping status→active)
    // pushes a fresh snapshot with no reload. Returning `unsubscribe` as the cleanup means
    // React calls it on unmount; Firestore fires no callbacks after unsubscribe, so — unlike
    // the awaited fetch — there's no setState-after-unmount risk and no `active` guard needed.
    const unsubscribe = subscribeToActiveRoadEvents(
      (data) => {
        setEvents(data);
        setError(null);
        setLoading(false); // first callback replaces "fetch resolved"
      },
      () => {
        setError('Couldn’t load road events.');
        setLoading(false);
      },
    );
    return unsubscribe;
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

  // Auto-dismiss the submit confirmation after a few seconds (also clearable by tapping).
  useEffect(() => {
    if (!confirmation) return;
    const timer = setTimeout(() => setConfirmation(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmation]);

  // Apple Maps (iOS) doesn't repaint a marker added after the map has settled — an event
  // that arrives via the live listener (e.g. an approval flipping status→active) lands in
  // state but only draws on the next viewport change. Force a redraw when `events` changes:
  //  - defer via setTimeout so the native annotation is added before we move the camera,
  //  - move by a supra-pixel delta over a real duration so it registers as a viewport change,
  //  - then animate back so the map ends where it started.
  // Skip the first non-empty emission: those markers paint fine as part of the map's first
  // layout, so nudging them is a redundant wobble on every launch. Empty snapshots don't
  // consume the guard (a cold start with zero active events still isn't nudged).
  const didInitialEvents = useRef(false);
  useEffect(() => {
    if (events.length === 0) return;
    if (!didInitialEvents.current) {
      didInitialEvents.current = true;
      return;
    }
    const map = mapRef.current;
    if (!map) return;

    let restoreTimer: ReturnType<typeof setTimeout>;
    const nudgeTimer = setTimeout(() => {
      map
        .getCamera()
        .then((camera) => {
          map.animateCamera(
            { center: { latitude: camera.center.latitude + 0.0005, longitude: camera.center.longitude } },
            { duration: 200 },
          );
          // Known limitation (cleanup commit): if the user is mid-pan when this fires, the
          // restore yanks the map back to the pre-nudge camera. Rare; not guarded yet.
          restoreTimer = setTimeout(() => {
            mapRef.current?.animateCamera(camera, { duration: 200 });
          }, 260);
        })
        .catch(() => {
          // getCamera can reject if the map isn't ready yet; the next change will retry.
        });
    }, 60);

    return () => {
      clearTimeout(nudgeTimer);
      clearTimeout(restoreTimer);
    };
  }, [events]);

  const showBanner = loading || error !== null || events.length === 0;

  // Stack the Cancel pill above the "Location off" bottom pill when both show, so they
  // never overlap; otherwise it sits at the normal bottom position. The top status pill
  // lives at the top edge, so there's no collision there either.
  const cancelBottom = insets.bottom + 16 + (locationStatus === 'denied' ? 56 : 0);
  // Transient notice row (submit error OR confirmation — mutually exclusive) sits one
  // row above the draft pill so it never overlaps the draft, denied, or top pills.
  const noticeBottom = cancelBottom + 56;

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
        <ThemedView style={[styles.banner, { bottom: noticeBottom }]}>
          <ThemedText type="defaultSemiBold">Submit failed: {submitError}</ThemedText>
        </ThemedView>
      )}

      {confirmation && (
        <ThemedView style={[styles.banner, { bottom: noticeBottom }]}>
          <Pressable onPress={() => setConfirmation(null)} hitSlop={8}>
            <ThemedText type="defaultSemiBold">{confirmation}</ThemedText>
          </Pressable>
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
