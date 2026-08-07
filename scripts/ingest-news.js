#!/usr/bin/env node

/**
 * News-ingestion script for zadar-roads.
 *
 * Reads the Antena Zadar RSS feed, asks Claude to extract Zadar road events that
 * match the RoadEvent schema, and writes each one to Firestore as a `pending`
 * report for manual approval. Standalone — NOT part of the Expo app bundle.
 *
 * Run:
 *   node --env-file=.env scripts/ingest-news.js                 # default feed, skip already-ingested
 *   node --env-file=.env scripts/ingest-news.js --force         # re-process everything (ignore markers)
 *   node --env-file=.env scripts/ingest-news.js --feed <url>    # target a different feed (or INGEST_FEED_URL env)
 *   node --env-file=.env scripts/ingest-news.js --max-age-days 7   # staleness cutoff in days (default 3)
 *
 * Credentials come from .env (never hardcoded, never logged, never committed):
 *   ANTHROPIC_API_KEY                 — read automatically by the Anthropic SDK
 *   GOOGLE_APPLICATION_CREDENTIALS    — read automatically by firebase-admin
 */

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
// firebase-admin v14 ships the MODULAR API: `applicationDefault` lives on the
// `firebase-admin/app` subpath (not `admin.credential.*`), and Firestore comes
// from `firebase-admin/firestore` via getFirestore (not `admin.firestore()`).
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const Parser = require('rss-parser');

// ── Config ──────────────────────────────────────────────────────────────────
// Feed selection: `--feed <url>` flag wins, else INGEST_FEED_URL env, else the
// default main feed. Lets you point at e.g. the roadworks-tag feed as a positive
// control (.../oznaka/radovi-na-cesti/feed/) where every article IS about roadworks.
const DEFAULT_FEED_URL = 'https://www.antenazadar.hr/feed/';
function resolveFeedUrl(argv) {
  const i = argv.indexOf('--feed');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.env.INGEST_FEED_URL || DEFAULT_FEED_URL;
}
const FEED_URL = resolveFeedUrl(process.argv);
const FEED_NAME = new URL(FEED_URL).host.replace(/^www\./, ''); // provenance, e.g. 'antenazadar.hr'

// Single, easily-changeable model constant. Swap to 'claude-sonnet-5' to compare
// extraction accuracy against Haiku. (Re-run with --force so previously-skipped
// articles are re-sent to the new model, otherwise you'd only compare new items.)
const MODEL = 'claude-haiku-4-5';

// TODO(geocode): every event is pinned to Zadar centre until geocoding is added.
const ZADAR_CENTRE = { latitude: 44.1194, longitude: 15.2314 };

const ROAD_EVENTS = 'roadEvents'; // where approved-pending events land
const INGESTED = 'ingestedArticles'; // idempotency markers, keyed by hashed URL

const FORCE = process.argv.includes('--force');

// Skip articles older than this many days BEFORE the Claude call, so stale feed
// entries (the roadworks tag feed carries 2024–2025 items) cost nothing. This is
// an ingestion filter only — it does NOT age existing events off the map (that's
// the known-unused status:'expired' gap, deliberately out of scope).
//
// Default is 3 days, NOT 24h, on purpose: this runs on a daily schedule, and a
// strict 1-day window would permanently lose a day's articles if a single run
// fails. A 3-day window overlaps across runs; the URL-keyed markers absorb the
// repeats at no API cost. The overlap is intentional — don't tighten it to 1.
// Override with --max-age-days N.
function resolveMaxAgeDays(argv) {
  const i = argv.indexOf('--max-age-days');
  if (i !== -1 && argv[i + 1] !== undefined) {
    const n = Number(argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3;
}
const MAX_AGE_DAYS = resolveMaxAgeDays(process.argv);
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

// ── Structured-output tool forced on the model ──────────────────────────────
// `type` and `severity` enums are copied VERBATIM from types/road-event.ts
// (RoadEventType / RoadEventSeverity). This is a .js file, so tsc cannot catch
// drift — if the unions change, update these by hand or the script will write
// documents that violate the RoadEvent type.
const TOOL = {
  name: 'extract_road_events',
  description:
    'Extract road events (roadworks, closures, construction, traffic restrictions) ' +
    'affecting the Zadar, Croatia area that are EXPLICITLY described in this article. ' +
    'Most articles are NOT about roadworks — return an empty events array for those. ' +
    'Never infer or invent events.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['events'],
    properties: {
      events: {
        type: 'array',
        description: 'Empty array if the article is not about a Zadar road event.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'severity', 'title', 'description'],
          properties: {
            type: {
              type: 'string',
              enum: ['construction', 'roadworks', 'closure', 'accident', 'other'],
            },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            title: { type: 'string', description: 'Short label, e.g. street + what is happening' },
            description: { type: 'string' },
            roadName: { type: 'string', description: 'Affected street/road if named; omit otherwise' },
            startDate: {
              type: 'string',
              description:
                'ISO 8601 date the works START, ONLY if the article explicitly states one. ' +
                'Omit if the article does not state a start date.',
            },
          },
        },
      },
    },
  },
};

// ── Clients ─────────────────────────────────────────────────────────────────
// getFirestore() with no id targets the '(default)' database. If your project's
// database has a different ID, the mismatch surfaces as PERMISSION_DENIED/NOT_FOUND.
const DATABASE_ID = '(default)';
const app = initializeApp({ credential: applicationDefault() }); // applicationDefault() reads GOOGLE_APPLICATION_CREDENTIALS
const db = getFirestore();
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// gRPC status codes we translate to readable names in errors.
const GRPC_CODES = { 5: 'NOT_FOUND', 7: 'PERMISSION_DENIED', 16: 'UNAUTHENTICATED' };

// Build a descriptive error for a failed Firestore call: which operation, which
// collection, which project/database, the gRPC code — plus, for PERMISSION_DENIED
// from the admin SDK, an IAM/targeting checklist (admin bypasses security rules).
function firestoreError(err, op, collection) {
  const project = app.options.projectId ?? 'zadar-roads';
  const codeName =
    typeof err.code === 'number' ? (GRPC_CODES[err.code] ?? `gRPC ${err.code}`) : null;
  const lines = [
    `Firestore ${op} failed on '${collection}' (project '${project}', database '${DATABASE_ID}')` +
      (codeName ? ` — ${codeName}` : ''),
    `  ${err.message}`,
  ];
  if (err.code === 7) {
    lines.push(
      '  NOTE: PERMISSION_DENIED from the ADMIN SDK is NOT your security rules (admin bypasses',
      '        them). It authenticated (code 7, not 16/UNAUTHENTICATED), so the key is valid —',
      '        this is authorization or database targeting. Check, for this project:',
      '        1. Cloud Firestore API is ENABLED.',
      "        2. The service account (the key's client_email) has a Firestore role:",
      "           'Cloud Datastore User' or 'Firebase Admin SDK Administrator Service Agent'.",
      `        3. A '${DATABASE_ID}' database exists (Native mode, eur3). If your database ID`,
      "           differs, tell me and I'll target it via getFirestore(app, '<id>').",
    );
  }
  return new Error(lines.join('\n'));
}

// One cheap, non-retrying read to surface auth/targeting problems up front —
// before the RSS fetch and any Claude calls — instead of failing mid-loop.
async function preflightFirestore() {
  try {
    await db.collection(INGESTED).limit(1).get();
  } catch (err) {
    throw firestoreError(err, 'connectivity check (read)', INGESTED);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function articleId(url) {
  // Article URLs contain '/', which is illegal in a Firestore doc id; hash them.
  return crypto.createHash('sha256').update(url).digest('hex');
}

async function extractEvents(item) {
  // NOTE: item.contentSnippet is the FEED EXCERPT, not the full article body, so
  // extraction quality is bounded by what the excerpt happens to include.
  // TODO: fetch and parse the full article page (item.link) for richer input.
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      'You extract road events (roadworks, closures, construction, traffic restrictions) ' +
      'affecting Zadar, Croatia from news text. Most articles are unrelated — in that case ' +
      'return {"events": []}. Only extract events the article explicitly states; never infer ' +
      'or invent. When the article states a date the works start, put it in startDate; ' +
      'otherwise omit it.',
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'extract_road_events' }, // model MUST call the tool
    messages: [
      { role: 'user', content: `Title: ${item.title ?? ''}\n\n${item.contentSnippet ?? ''}` },
    ],
  });

  // Forced tool_choice guarantees a tool_use block; its `input` is already parsed.
  // An article with no road events comes back as { events: [] } — the decline path.
  const block = response.content.find((b) => b.type === 'tool_use');
  return block ? block.input.events : [];
}

function buildDoc(event, item, now) {
  // startTime: prefer a stated works-start date; fall back to the article's
  // publication date as a PROXY (they differ — an article can predate the works),
  // and to `now` if pubDate is missing/unparseable.
  let startTime = Date.parse(item.pubDate ?? '');
  if (Number.isNaN(startTime)) startTime = now;
  if (event.startDate) {
    const stated = Date.parse(event.startDate);
    if (!Number.isNaN(stated)) startTime = stated;
  }

  const doc = {
    type: event.type,
    severity: event.severity,
    title: event.title,
    description: event.description,
    latitude: ZADAR_CENTRE.latitude,
    longitude: ZADAR_CENTRE.longitude,
    startTime,
    status: 'pending', // ENFORCED here — firebase-admin bypasses security rules
    source: {
      kind: 'ingested',
      feed: FEED_NAME,
      articleUrl: item.link,
      articleTitle: item.title ?? '',
      model: MODEL,
    },
    createdAt: now,
    updatedAt: now,
  };
  if (event.roadName) doc.roadName = event.roadName; // optional field — omit when absent
  return doc;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `Targeting Firestore: project '${app.options.projectId ?? 'zadar-roads'}', database '${DATABASE_ID}'.`,
  );
  console.log(`Feed: ${FEED_URL}${FORCE ? '  (--force: ignoring markers)' : ''}`);
  console.log(`Max article age: ${MAX_AGE_DAYS} days`);
  await preflightFirestore(); // fail fast on auth/targeting before RSS + Claude calls

  const parser = new Parser({ headers: { 'User-Agent': 'zadar-roads-ingest/1.0' } });
  // FEED SIZE LIMIT: this WordPress feed returns only ~10 newest items per request
  // (posts_per_rss default). --max-age-days filters what those ~10 contain; it cannot
  // fetch more. On a busy news day 10 items can span only a few hours, so a road-events
  // article can scroll off the single page before a once-daily run sees it.
  //   => Schedule this every few HOURS, not daily.
  // Older items ARE reachable via `?paged=N` (verified: ?paged=2 returns the next, older
  // page) — a future backfill could page through them; deliberately not implemented here.
  const feed = await parser.parseURL(FEED_URL);
  const items = feed.items ?? [];

  let skipped = 0;
  let tooOld = 0;
  let withEvents = 0;
  let produced = 0;
  let noEvents = 0;

  for (const item of items) {
    if (!item.link) continue; // can't key idempotency or cite the source without a URL

    const markerRef = db.collection(INGESTED).doc(articleId(item.link));

    // Idempotency: skip articles already processed, UNLESS --force. Markers exist
    // even for 0-event articles, so unrelated ones aren't re-sent to Claude each run.
    if (!FORCE) {
      let existing;
      try {
        existing = await markerRef.get();
      } catch (err) {
        throw firestoreError(err, 'read', INGESTED);
      }
      if (existing.exists) {
        skipped++;
        console.log(`  [skip]   ${item.title ?? '(untitled)'}`);
        continue;
      }
    }

    // Max-age gate: skip stale articles BEFORE the Claude call, so they cost
    // nothing. Missing/unparseable pubDate → Date.parse returns NaN; such items
    // are PROCESSED (fall through), not aged out — we can't prove they're stale,
    // and dropping a possibly-current article is worse than one Claude call
    // (buildDoc falls back to `now` for startTime). Only a PARSEABLE date beyond
    // the window is skipped.
    const publishedAt = Date.parse(item.pubDate ?? '');
    if (!Number.isNaN(publishedAt) && Date.now() - publishedAt > MAX_AGE_MS) {
      tooOld++;
      const ageDays = Math.floor((Date.now() - publishedAt) / 86_400_000);
      console.log(`  [old]    ${item.title ?? '(untitled)'}  (${ageDays} days)`);
      continue;
    }

    const events = await extractEvents(item);
    const now = Date.now();

    // Write the events AND the marker atomically, so a crash can't leave events
    // without a marker (which would duplicate them on the next run).
    const batch = db.batch();
    for (const event of events) {
      batch.set(db.collection(ROAD_EVENTS).doc(), buildDoc(event, item, now));
    }
    batch.set(markerRef, {
      url: item.link,
      title: item.title ?? null,
      processedAt: now,
      eventCount: events.length,
      model: MODEL,
    });
    try {
      await batch.commit();
    } catch (err) {
      throw firestoreError(err, 'batched write', `${ROAD_EVENTS} + ${INGESTED}`);
    }

    const title = item.title ?? '(untitled)';
    if (events.length > 0) {
      withEvents++;
      produced += events.length;
      console.log(`  [${events.length} event${events.length > 1 ? 's' : ''}] ${title}`);
      for (const e of events) {
        console.log(`      -> ${e.type}/${e.severity}: ${e.title}${e.roadName ? ` (${e.roadName})` : ''}`);
      }
    } else {
      noEvents++;
      // Snippet length distinguishes a judgement decline (real text) from an
      // empty-input decline (tiny/empty excerpt → nothing to work with).
      const snippetLen = (item.contentSnippet ?? '').length;
      console.log(`  [none]   ${title}  (snippet: ${snippetLen} chars)`);
    }
  }

  console.log('── Ingestion summary ──');
  console.log(`Feed items read:      ${items.length}`);
  if (FORCE) {
    console.log('Mode:                 --force (markers ignored, all re-processed)');
  } else {
    console.log(`Already ingested:     ${skipped}  (skipped, no API call)`);
  }
  console.log(`Too old (>${MAX_AGE_DAYS}d):      ${tooOld}  (skipped, no API call)`);
  console.log(`Articles with events: ${withEvents}`);
  console.log(`Events produced:      ${produced}  (all written pending)`);
  console.log(`No road events:       ${noEvents}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // Surface the message but never dump env/credentials.
    console.error('Ingestion failed:', err.message);
    process.exit(1);
  });
