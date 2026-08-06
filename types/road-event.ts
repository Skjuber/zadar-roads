// Canonical domain type for a road construction / blockage event in zadar-roads.
// One shape for BOTH official (HAK/HAC, likely DATEX II) data and user submissions.
// Fields marked "DATEX-friendly" mirror DATEX II SituationRecord semantics so official
// ingestion can map onto them with minimal transformation later. Others are custom.

/** What kind of road event. Flattened, lean subset of DATEX II situation-record classes. DATEX-friendly. */
export type RoadEventType =
  | 'construction' // DATEX Roadworks → ConstructionWorks
  | 'roadworks' // DATEX Roadworks → MaintenanceWorks
  | 'closure' // DATEX RoadOrCarriagewayOrLaneManagement → roadClosed
  | 'accident' // DATEX Accident
  | 'other'; // catch-all for user reports that don't fit above

/** Impact level. Lean subset of DATEX II SeverityEnum (unknown/lowest/low/medium/high/highest). DATEX-friendly. */
export type RoadEventSeverity = 'low' | 'medium' | 'high';

/** Moderation + lifecycle state. Custom — user submissions need a gate before they show on the map. */
export type RoadEventStatus =
  | 'pending' // user-submitted, awaiting manual approval (MVP: manual-first)
  | 'active' // approved / official, currently in effect
  | 'expired' // endTime has passed
  | 'rejected'; // moderated out

/** Provenance. Discriminates official ingestion, a user report, and AI-extracted news. Custom (but ingestion-friendly). */
export type RoadEventSource =
  | {
      kind: 'official';
      provider: 'HAK' | 'HAC';
      externalId: string; // upstream DATEX II SituationRecord id — for idempotent re-ingest / dedupe
    }
  | {
      kind: 'user';
      reporterId: string; // app user id who submitted the report
      photoUrl?: string; // Firebase Storage URL of an optional attached photo
    }
  | {
      kind: 'ingested'; // AI-extracted from a news feed, awaiting approval (like 'user', starts pending)
      feed: string; // source feed, e.g. 'antenazadar.hr'
      articleUrl: string; // approver verifies the claim against this
      articleTitle: string;
      model: string; // Claude model that extracted it — audit trail
    };

export interface RoadEvent {
  // --- Identity ---
  id: string; // Firestore document id. Custom (maps to DATEX SituationRecord.id for official rows).

  // --- Classification (DATEX-friendly) ---
  type: RoadEventType;
  severity: RoadEventSeverity;

  // --- Human-facing content (Custom) ---
  title: string; // short label shown in the marker callout, e.g. "Ul. Ante Starčevića closed"
  description?: string; // optional free-text detail (DATEX rough analog: generalPublicComment)

  // --- Location (DATEX-friendly: DATEX PointCoordinates) ---
  latitude: number; // WGS84; feeds Marker `coordinate` directly
  longitude: number; // WGS84
  roadName?: string; // e.g. "D8" or a city street name (DATEX road location reference)

  // --- Validity window (DATEX-friendly: validityTimeSpecification) ---
  startTime: number; // epoch ms. DATEX overallStartTime.
  endTime?: number; // epoch ms. DATEX overallEndTime. Absent = open-ended / unknown.

  // --- Lifecycle + provenance ---
  status: RoadEventStatus; // Custom
  source: RoadEventSource; // Custom (discriminated)

  // --- Record bookkeeping (DATEX-friendly) ---
  createdAt: number; // epoch ms. DATEX situationRecordCreationTime.
  updatedAt: number; // epoch ms. DATEX situationRecordVersionTime.
}
