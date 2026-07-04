import { getApp, getApps, initializeApp } from 'firebase/app';
import { getFirestore, initializeFirestore, type Firestore } from 'firebase/firestore';

// Firebase Web config for the zadar-roads project. These values are NOT secrets — they
// identify the project to Firebase and ship in every client build. Access is governed by
// Firestore security rules (a pre-launch requirement; see CLAUDE.md).
const firebaseConfig = {
  apiKey: 'AIzaSyA9pwDoH-VeMMkh8cj-q3b7WkU46Gl1UK8',
  authDomain: 'zadar-roads.firebaseapp.com',
  projectId: 'zadar-roads',
  storageBucket: 'zadar-roads.firebasestorage.app',
  messagingSenderId: '745687278210',
  appId: '1:745687278210:web:0647b7f2d4d0af719a0a9b',
};

// Guard against re-initialization during Fast Refresh / repeated imports.
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Force HTTP long polling: the default WebChannel/gRPC transport is unreliable on React
// Native (mobile networks, office-WiFi proxies) and surfaces as "Listen stream transport
// errored". initializeFirestore can run only once per app, so on a second module
// evaluation (Fast Refresh) fall back to the already-initialized instance.
let db: Firestore;
try {
  db = initializeFirestore(app, { experimentalForceLongPolling: true });
} catch {
  db = getFirestore(app);
}

export { app, db };
