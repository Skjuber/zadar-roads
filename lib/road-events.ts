import {
  addDoc,
  collection,
  onSnapshot,
  query,
  where,
  type FirestoreError,
  type Unsubscribe,
} from 'firebase/firestore';

import { db } from '@/lib/firebase';
import type { RoadEvent } from '@/types/road-event';

const COLLECTION = 'roadEvents';

/**
 * Live subscription to active road events. Calls `onData` with the current set on the
 * first callback and again on every change; calls `onError` if the listener fails.
 * Returns Firestore's unsubscribe function — call it to stop listening.
 *
 * Filtered to `status == 'active'`: never surfaces `pending`/`rejected` docs, and keeps
 * the live listener off the unbounded collection.
 */
export function subscribeToActiveRoadEvents(
  onData: (events: RoadEvent[]) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const activeEvents = query(collection(db, COLLECTION), where('status', '==', 'active'));
  return onSnapshot(
    activeEvents,
    (snapshot) => {
      onData(
        snapshot.docs.map((docSnap) => ({
          ...(docSnap.data() as Omit<RoadEvent, 'id'>),
          id: docSnap.id, // doc id is the source of truth; overrides any stored `id`
        })),
      );
    },
    onError,
  );
}

/**
 * Write a minimal user-submitted RoadEvent at the given point, using placeholder
 * content (no form yet). Values are taken from the RoadEvent schema — not invented.
 * The shape satisfies the rules' stated constraints: `status: 'pending'` and
 * `source.kind: 'user'`. Rejections (e.g. permission-denied) propagate to the caller
 * so the UI can surface them. `id` is intentionally omitted — `doc.id` is authoritative.
 */
export async function submitDraftReport(coordinate: {
  latitude: number;
  longitude: number;
}): Promise<void> {
  const now = Date.now();
  const report: Omit<RoadEvent, 'id'> = {
    type: 'construction',
    severity: 'low',
    title: 'Test report',
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    startTime: now,
    status: 'pending',
    source: { kind: 'user', reporterId: 'anonymous' },
    createdAt: now,
    updatedAt: now,
  };
  await addDoc(collection(db, COLLECTION), report);
}
