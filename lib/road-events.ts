import { collection, getDocs } from 'firebase/firestore';

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
