import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

export type LocationPermissionStatus = 'loading' | 'granted' | 'denied';

/**
 * Requests foreground location permission on mount and reads the position once.
 * The one-time position is used to recenter the map; the live "updates as you move"
 * dot is driven natively by react-native-maps' `showsUserLocation`.
 */
export function useUserLocation() {
  const [status, setStatus] = useState<LocationPermissionStatus>('loading');
  const [position, setPosition] = useState<Location.LocationObjectCoords | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { status: permission } = await Location.requestForegroundPermissionsAsync();
      if (!active) return;
      if (permission !== 'granted') {
        setStatus('denied');
        return;
      }
      setStatus('granted');
      try {
        const current = await Location.getCurrentPositionAsync({});
        if (active) setPosition(current.coords);
      } catch {
        // Position read can fail transiently; the native dot still tracks the user.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return { status, position };
}
