# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> The line above is a hard requirement: Expo SDK 54 differs significantly from older versions. Consult https://docs.expo.dev/versions/v54.0.0/ before writing or changing any Expo/React Native code, rather than relying on memorized APIs.

## Commands

```bash
npm install            # install dependencies
npx expo start         # start Metro bundler (press i / a / w for ios / android / web)
npm run ios            # start + open iOS simulator
npm run android        # start + open Android emulator
npm run web            # start + open web
npm run lint           # eslint (expo-config flat), the only check wired up
```

There is no test runner, build script, or typecheck script configured. Type checking happens via the editor / `npx tsc --noEmit` (strict mode is on). `npm run reset-project` moves the starter code into `app-example/` and scaffolds a blank `app/` — it is a one-time template helper, not part of normal development.

## Architecture

Universal (iOS + Android + web) app built on **Expo Router** with file-based routing. New Architecture (`newArchEnabled`) and the **React Compiler** (`experiments.reactCompiler`) are both on, so avoid manual `useMemo`/`useCallback` micro-optimizations the compiler handles. Typed routes are enabled, so route strings are type-checked.

- **Routing lives in `app/`.** `app/_layout.tsx` is the root Stack; `app/(tabs)/_layout.tsx` defines the bottom tab navigator. Each file under `app/` is a screen; the `(tabs)` group routes are the anchor (`unstable_settings.anchor`). `app/modal.tsx` is a modal-presented stack screen.
- **`@/*` path alias** maps to the repo root (see `tsconfig.json`), e.g. `@/components/...`, `@/hooks/...`, `@/constants/theme`.
- **Theming is manual, not a library.** `constants/theme.ts` holds `Colors` (light/dark) and platform `Fonts`. Components read the active scheme via `hooks/use-color-scheme` and resolve a color with `hooks/use-theme-color`. Use `ThemedText` / `ThemedView` rather than raw `Text` / `View` so dark mode works.
- **Platform-specific files** use Metro's extension resolution: `*.ios.tsx` / `*.web.ts` override the base file per platform (e.g. `components/ui/icon-symbol.ios.tsx` renders native SF Symbols while `icon-symbol.tsx` falls back to Material Icons; `use-color-scheme.web.ts` adds web hydration handling). When adding such a component, keep the prop signatures identical across variants.
- **Icons:** `IconSymbol` takes SF Symbol names and maps them to Material Icons for Android/web via the `MAPPING` table in `components/ui/icon-symbol.tsx` — add a mapping entry when introducing a new icon name.

## Conventions

- File names are **kebab-case** (`themed-text.tsx`, `use-color-scheme.ts`); React components are PascalCase.
- The URL scheme is `zadarroads` (deep links / `expo-linking`).

## Project Context & Key Decisions

**What this is:** A road construction/blockage notification app for Zadar, Croatia. Shows open vs blocked routes on a map, accepts user-submitted road event reports with GPS tagging, and sends push notifications for construction events. May expand to wider Croatia later.

**Backend — Firebase:**
- Firestore via the **JS SDK** (`firebase`), **not** `react-native-firebase`.
- Firebase Cloud Messaging for push; Firebase Storage for user-submitted photos.
- Firestore region is **`eur3` (Europe)** — **PERMANENT**, chosen for GDPR / EU data residency. Never suggest changing it.

**Data model:** The canonical Firestore schema is a **`RoadEvent`** (still being designed) that must accommodate **both** official road data and user submissions.
- Official data: HAK/HAC publish geolocated road-event data (likely DATEX II) for state/county/highway roads but **not** Zadar city streets. User submissions are therefore strategically essential to cover city streets.

**Maps:** `react-native-maps` — **not yet installed**; installing it is the next build step.

**Testing:** On a physical iPhone via **Expo Go in tunnel mode** (`npx expo start --tunnel`). LAN mode is unreliable on shared/office WiFi due to client isolation.

**MVP philosophy:** Manual-first, AI-assisted-later. Keep scope minimal; defer automation/agentic pipelines.

**Before launch (GDPR):** Firestore security rules and a user-data-deletion capability are required.

**Pre-scale requirement (before ingesting official data or accepting real user submissions):** `fetchRoadEvents` (`lib/road-events.ts`) currently reads the entire `roadEvents` collection unfiltered — fine only for MVP with a handful of docs. Before real data volume, it must become a **filtered, bounded query**: active-only (`status == 'active'`, so `pending`/`rejected` user submissions never leak onto the map) and geo-limited (Zadar bounds, not all of Croatia), with `limit`/pagination. Firestore **security rules must be tightened to match** — only expose active events, never `pending`/`rejected` docs (which carry `reporterId`). This is both a cost/perf and a GDPR/moderation concern.
