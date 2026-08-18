# Zadar Roads

A map of road construction and closures in Zadar, Croatia.

<!-- TODO: demo video link here -->
<!-- TODO: screenshots — the map with approved pins, the report form, a pending→active approval -->

## 1. What it is

Zadar Roads shows where the city's streets are dug up or closed. The map displays
active roadworks and closures as pins; tapping one shows what is happening there.
Anyone can report a new site by long-pressing the map, and road-events mentioned in
local news are extracted automatically by a background script. Every event — whether
a resident typed it or a language model extracted it — is written as `pending` and
appears on the map only after a person approves it. The app is Expo / React Native;
the backend is Firebase (Firestore).

## 2. Why

Zadar is under near-constant roadworks, and information about them is scattered.
The city publishes some works as official notices; local outlets report others; a
large share — a crew that shows up and closes a street for a morning — is announced
nowhere at all. There is no single place a resident can look to answer "is this
street open right now." This project is an attempt at that single place, drawing
from all three kinds of source into one map.

## 3. Architecture

Three producers feed one moderation queue. Nothing a producer writes is trusted: it
lands as `pending` and a human decides whether it becomes visible.

```
resident report  ─┐
AI news ingestion ─┼──▶  pending  ──▶  human approves  ──▶  active  ──▶  map
official feeds    ─┘                        │
                                            └──▶  rejected
```

The central design decision is that **no producer can put a pin on the map.** The
map's live query returns only `status == 'active'`, and the only way a document
becomes `active` is a human moving it there. This is deliberate: a resident could be
wrong or malicious, and — as Section 7 shows — the language model is wrong often
enough that its output cannot be trusted directly. The approval step is the whole
point of the queue, not an afterthought.

Two producers are implemented today: resident reports (in the app) and AI news
ingestion (a standalone script). The third, official data (Croatia's HAK/HAC road
feeds, likely DATEX II), is modelled in the type system but not yet ingested.
Approval is currently a manual step in the Firebase console — flipping a document's
`status` from `pending` to `active`; an in-app moderation screen is future work.

## 4. The data model

Everything is a `RoadEvent` (`types/road-event.ts`). One shape serves all three
producers, which is what lets them share a single queue.

**Status lifecycle.** `status` is one of:

- `pending` — written by a producer, awaiting review.
- `active` — approved and currently in effect; this is the only status the map shows.
- `rejected` — reviewed and dismissed.
- `expired` — its validity window has passed. (Defined, not yet used — see Section 10.)

**Provenance as a discriminated union.** `source` is not a free-form string; it is a
tagged union, and each variant carries exactly the fields that provenance can vouch
for:

- `{ kind: 'user', reporterId, photoUrl? }` — a resident submission.
- `{ kind: 'ingested', feed, articleUrl, articleTitle, model }` — extracted from a
  news article. The `articleUrl` lets an approver read the original and check the
  claim; `model` records which model produced it, as an audit trail.
- `{ kind: 'official', provider, externalId }` — an official record, keyed by its
  upstream id for idempotent re-ingestion.

Modelling provenance this way means the reviewer always knows *where a claim came
from and how to verify it*, and the type system prevents nonsense like a user report
carrying an `externalId`. It also keeps the door open for automated trust rules later
(e.g. official records could skip manual review) without changing the shape.

**DATEX II friendly.** The fields mirror DATEX II SituationRecord semantics — point
coordinates, an `startTime`/`endTime` validity window, `createdAt`/`updatedAt`
bookkeeping, all as epoch-millisecond numbers. That is so official DATEX data can be
mapped onto `RoadEvent` with minimal transformation when that producer is built.

## 5. The app

Expo / React Native.

**A live listener, not a fetch.** The map subscribes to Firestore with
`onSnapshot(query(..., where('status','==','active')))` (`lib/road-events.ts`). A
one-off fetch would show a stale snapshot; the listener means that the moment a
reviewer approves an event in the console, the pin appears on every open device with
no reload and no user action. The filter is also a privacy boundary — `pending` and
`rejected` documents never leave the server, so unreviewed or dismissed reports are
never on a user's phone. The subscription returns Firestore's own unsubscribe
function as the effect cleanup, so there is no set-state-after-unmount race.

**Long-press, not tap, to drop a pin.** Tapping the map is how you pan and inspect;
making a tap create a report would generate accidental submissions constantly.
Long-press is the deliberate "drop a pin here" gesture (the same convention as Google
Maps). The trade-off, verified on device, is that a long-press that lands on an
existing marker still falls through to the map and drops a draft — accepted, because
the alternative (swallowing the gesture near pins) is worse in a dense area.

**A draggable draft pin.** The dropped pin is draggable, so a reporter can nudge it
onto the exact spot before committing, rather than having to long-press repeatedly.

**A form that cannot drift from the schema.** The report form's Type and Severity
choices are not a hand-written list. They are derived from the `RoadEventType` and
`RoadEventSeverity` unions through `Record<RoadEventType, string>` /
`Record<RoadEventSeverity, string>` label maps (`components/report-form.tsx`). Because
a `Record` keyed by a union must have an entry for every member, adding or removing a
union member makes the form fail to compile until the maps are updated — the UI can't
silently fall out of sync with the type. Title is required (submit is disabled until
it has content); description is optional.

**User position.** `hooks/use-user-location.ts` requests foreground location
permission on mount and takes a single position fix, used once to recenter the map on
the user. The live "blue dot that tracks you" is handled natively by react-native-maps
(`showsUserLocation`), so the app doesn't poll. A denied permission is a first-class
state, surfaced to the user rather than failing silently.

**Transport note.** Firestore is initialised with `experimentalForceLongPolling`
(`lib/firebase.ts`). The default WebChannel/gRPC transport is unreliable on React
Native over mobile networks and behind office-WiFi proxies (it surfaces as "Listen
stream transport errored"); long polling trades a little efficiency for a connection
that actually stays up on a phone.

## 6. The AI ingestion

`scripts/ingest-news.js` is a standalone Node script — not part of the app bundle. It
reads a news RSS feed, asks Claude to extract any Zadar road events, and writes each
one to Firestore as `pending`.

**RSS parsing.** It fetches and parses the feed with `rss-parser`, giving `title`,
`link`, `pubDate`, and a `contentSnippet` per item. It sends the model the title plus
the snippet — which is the feed *excerpt*, not the full article, a limitation noted in
the code and in Section 10.

**Idempotency by article URL.** Each processed article gets a marker document in an
`ingestedArticles` collection, keyed by the SHA-256 of its URL (URLs contain `/`, which
is illegal in a Firestore document id). Before calling the model, the script checks for
the marker and skips the article if present — so re-running is safe and cheap.
Crucially, a marker is written **even when an article produces zero events**, so
unrelated articles are not re-sent to the model on every run. The events and the marker
are written in a single atomic batch, so a crash can't leave events without a marker
(which would duplicate them next run).

**Max-age filter, before the model call.** Articles older than a cutoff (default 3
days, `--max-age-days` to override) are skipped *before* any model call, so stale feed
entries cost nothing. The default is 3 rather than 1 on purpose: the script is meant
to run on a schedule, and a strict 24-hour window would permanently lose a day's
articles if a single run failed. A 3-day window overlaps between runs, and the URL
markers absorb the repeats at no API cost.

**A forced tool call, not prose.** The model is given a single tool and
`tool_choice: { type: 'tool', name: 'extract_road_events' }`, which forces it to
return its answer as the tool's JSON input rather than free text. An article with no
road events comes back as `{ events: [] }` — a structured decline, not a sentence to
parse. There is no natural-language parsing anywhere in the pipeline.

**A schema narrower than `RoadEvent`, on purpose.** The tool schema asks the model
only for what a reader can judge from the text: `type`, `severity`, `title`,
`description`, and optionally `roadName` and a stated `startDate`. It does **not** ask
for coordinates, `status`, or the record timestamps. The script sets those itself: a
fixed Zadar-centre coordinate, `createdAt`/`updatedAt` of now, and — this is the
important one — `status: 'pending'`, hardcoded. Because the model is never given the
`status` field, it cannot set an event to `active`; the pending guarantee for ingested
events is a property of the code, not a request to the model.

**Most articles correctly produce nothing.** The feed is general local news — politics,
sport, culture — and the great majority of articles are not about roadworks. The
correct output for those is an empty array, and the script's per-article log
distinguishes a genuine "nothing here" from an empty-input case so that can be
checked. The model runs on `claude-haiku-4-5`, set as a single constant so it can be
swapped for a larger model to compare accuracy.

## 7. What the AI gets wrong

This is the reason the approval step exists, so it is worth being blunt about.

The model is an unreliable narrator of its own source text. Two real failures from
testing:

- An article announcing that a road had **reopened** was extracted as an **active
  closure** — the opposite of what the article said. The model keyed on "closure" and
  a street name and missed that the news was the end of it.
- A general resident complaint about the city being dug up everywhere — no specific
  street, no specific works — was extracted as a **high-severity event with no
  location**, an event that does not correspond to anything real.

Across one run, roughly **half** the extractions needed rejecting. That is not a bug to
be tuned away; it is the expected behaviour of a text model asked to make judgement
calls about ambiguous local news. It is precisely why nothing the model produces
reaches the map on its own. The model is a drafting and triage step that turns
unstructured articles into reviewable candidates; a human is the authority. An
extraction pipeline without that human step would put false closures on the map.

## 8. Running it

Install:

```
npm install
```

Run the app (Metro bundler; press `i`/`a` for a simulator, or scan the QR with Expo Go
on a device):

```
npx expo start
```

Use `--tunnel` when the phone and the computer are not on a directly reachable LAN —
for example office or shared WiFi with client isolation, where the default LAN mode
can't connect. `--tunnel` routes through Expo's servers and is the reliable path for a
physical device on such networks:

```
npx expo start --tunnel
```

Run the news ingestion (the plain, no-argument case wraps `node --env-file=.env
scripts/ingest-news.js`):

```
npm run ingest
```

When you need flags, call `node` directly. On Windows PowerShell, `npm run ingest --
--flag` does **not** forward arguments reliably — they get swallowed and the script
runs with its defaults (I hit exactly this: a run I thought was `--force` on a custom
feed silently used the default feed with no `--force`). Calling `node` avoids the npm
argument-forwarding layer entirely:

```
node --env-file=.env scripts/ingest-news.js --force            # re-process everything, ignore the URL markers
node --env-file=.env scripts/ingest-news.js --feed <rss-url>   # use a different feed (or set INGEST_FEED_URL)
node --env-file=.env scripts/ingest-news.js --max-age-days 7   # widen/narrow the staleness cutoff (default 3)
```

**Positive control.** To confirm the model isn't silently declining everything, point
it at the outlet's own roadworks tag feed — where, by definition, every article *is*
about roadworks — with the markers ignored and the age window opened up:

```
node --env-file=.env scripts/ingest-news.js --force --feed https://www.antenazadar.hr/oznaka/radovi-na-cesti/feed/ --max-age-days 400
```

If that run extracts sensible events, the pipeline works and a quiet main-feed run was
correct. If it extracts nothing, something is broken.

**Environment.** The script reads two variables from a git-ignored `.env` (values are
never committed, logged, or printed):

- `ANTHROPIC_API_KEY` — read by the Anthropic SDK.
- `GOOGLE_APPLICATION_CREDENTIALS` — a filesystem path to the Firebase service-account
  JSON. That JSON lives **outside the repository** (e.g. in a user home-directory
  folder), so the admin credential is never in the project tree.

## 9. Security

Firestore security rules (deployed in the Firebase console) constrain what a client
can do to the `roadEvents` collection:

- **Create** is allowed only when the new document has `status == 'pending'` **and**
  `source.kind == 'user'`. A resident therefore cannot self-approve a report (write it
  `active`) or forge an official record.
- **Update** and **delete** by clients are denied outright. An existing event cannot be
  edited or removed from the app.

There is one important seam. The ingestion script authenticates with `firebase-admin`
and a service account, and the admin SDK **bypasses security rules entirely** — they do
not apply to it. So the "ingested events are always `pending`" guarantee cannot come
from the rules; it comes from the script's own code, where `status: 'pending'` is a
hardcoded literal the model is never allowed to influence (Section 6). The rules
protect the client path; the code protects the admin path.

(The Firebase *web* config in `lib/firebase.ts` includes an API key. That value is a
public project identifier, not a secret — it ships in every client build by design, and
access is governed by the rules above, not by keeping it hidden.)

## 10. Known limitations

Each of these is a deliberate boundary with a reason, not an oversight:

- **The RSS feed returns only ~10 items.** WordPress serves a fixed number of newest
  posts per feed request; `--max-age-days` can filter within those ten but cannot fetch
  more. On a busy news day ten items may span only a few hours, so a roadworks article
  can scroll off the single page before a once-a-day run ever sees it. The consequence
  is a scheduling requirement: **run every few hours, not daily.** Older items are
  reachable via `?paged=N` (verified), so a paging backfill is possible later; it is
  deliberately not built.
- **Nothing sets `status: 'expired'`.** The status and the `endTime` field exist, but no
  process acts on them, so an approved event stays on the map until a human removes it.
  Expiry was left out to keep the first version small.
- **Ingested events use a fixed Zadar-centre coordinate.** Geocoding street names to
  real positions was kept off the critical path, so every ingested pin lands at the city
  centre until corrected. The trade-off is that ingested events are useful as a list and
  a prompt for review, but not yet as precise map points.
- **Deduplication is by article, not by real-world event.** Two articles about the same
  closure produce two events. A human collapses them at approval time; the system does
  not.
- **Locations are points, not stretches.** A 500-metre closed road is one pin, not a
  line. The data model is DATEX-friendly enough to carry linear references eventually,
  but nothing populates them today.
- **An iOS repaint workaround.** On iOS (Apple Maps), a marker added *after* the map has
  settled — for instance an approval flipping an event to `active` while the app is open
  — lands in state but doesn't repaint until the next viewport change. The map works
  around this with a tiny, immediately-reversed camera nudge to force a redraw. Android
  (Google Maps) repaints on data change and needs none of this. The cost is a barely
  perceptible one-frame jiggle on iOS when new events arrive.
- **Reports are anonymous.** A submission's `reporterId` is a literal `'anonymous'`;
  there is no auth yet. The trade-off is no per-user rate-limiting, accountability, or
  "my reports" view until anonymous auth is added.

## 11. Cost and scaling

Extraction is cheap. A single article costs roughly **0.2 cents**; a full day of active
development against the pipeline cost about **nine cents** in model usage. That is with
no cost engineering at all — every article, relevant or not, is sent to the model.

The headroom, in the order I'd apply it:

- **A keyword pre-filter before the model.** Most articles don't contain "cesta",
  "radovi", "zatvor…", a street name, etc. A deterministic string check can drop those
  for free and never spend a token on them.
- **Batch several articles per request.** One call classifying a handful of articles
  amortises the fixed system-prompt and tool-schema cost across them.
- **Prompt caching on the identical prefix.** The system prompt and tool schema are
  byte-identical on every call; caching that prefix cuts the repeated input cost.
- **The Batch API for scheduled runs.** Ingestion is not latency-sensitive, so scheduled
  work can go through the batch endpoint at half price.

The principle underneath all four: **do cheap deterministic triage first, and spend the
model only where judgement is actually needed.** The model's value is reading ambiguous
prose; it shouldn't be paid to skip a football result.

## 12. What's next

- **Event expiry** — act on `endTime` / `status: 'expired'` so approved events age off
  the map on their own.
- **Geocoding** — turn street names into real coordinates so ingested events become
  accurate points.
- **Anonymous auth** — a stable anonymous identity per device, enabling rate-limiting,
  deduplication, and per-user moderation.
- **The keyword pre-filter** from Section 11.
- **Scheduled ingestion via GitHub Actions** — running the script every few hours
  (matching the RSS-cap constraint) instead of by hand.
- **More sources.** The city's own traffic notices are the authoritative upstream that
  the news outlets appear to republish; ingesting them directly would be higher-signal.
  (Practical caveat found while investigating: the city site appears to refuse
  connections from datacentre IP ranges, so a cloud-scheduled fetch of it may need a
  proxy or a locally-run job.)
- **Radio traffic bulletins** — the local station reads out closures; capturing those
  needs a separate speech-to-text step first, since the model used here is text-only.
- **An in-app moderation screen** — so approval isn't a manual trip to the Firebase
  console.
- **Photo attachments** — `source.user.photoUrl` is already modelled; wiring up capture
  and Firebase Storage is the remaining work.
- **A "road has reopened" report** — making the exact case the model got wrong
  (Section 7) a first-class user action, so residents can retire a stale closure.

## 13. Stack

- **App:** Expo `~54.0.34`, React Native `0.81.5`, React `19.1.0`, Expo Router
  `~6.0.23`, react-native-maps `1.20.1`, expo-location `~19.0.8`. New Architecture and
  the React Compiler are enabled (`app.json`).
- **Backend:** Firebase (Firestore) via the JS SDK `firebase ^12.15.0`. Firestore
  region is `eur3` (EU) for data residency.
- **Ingestion (Node, dev-only):** `@anthropic-ai/sdk ^0.115.0` on model
  `claude-haiku-4-5`, `firebase-admin ^14.2.0` (modular API), `rss-parser ^3.13.0`,
  run with Node's `--env-file`.
- **Tooling:** TypeScript `~5.9.2`, ESLint with `eslint-config-expo`.
