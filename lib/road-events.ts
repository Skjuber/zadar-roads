import { addDoc, collection, getDocs } from 'firebase/firestore';

import { db } from '@/lib/firebase';
import type { RoadEvent } from '@/types/road-event';

const COLLECTION = 'roadEvents';

/** One-time read of all readable road events. Returns [] when the collection is empty. */
export async function fetchRoadEvents(): Promise<RoadEvent[]> {
  const snapshot = await getDocs(collection(db, COLLECTION));
  return snapshot.docs.map((docSnap) => ({
    ...(docSnap.data() as Omit<RoadEvent, 'id'>),
    id: docSnap.id, // doc id is the source of truth; overrides any stored `id`
  }));
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
