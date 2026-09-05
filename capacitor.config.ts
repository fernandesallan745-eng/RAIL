import type { CapacitorConfig } from '@capacitor/cli';

// GATI iOS wrapper.
//
// TWO MODES, and the default matters:
//
//   1. Bundled (default).  No `server` URL is set, so Capacitor loads the web
//      app from `webDir` inside the app bundle.  The app therefore ALWAYS boots,
//      and `public/app.js` shows its in-app "Connect to live tracker" screen so
//      the Mac's address can be entered (and re-entered) on the device.
//
//   2. Dev server (opt-in).  Set GATI_DEV_SERVER_URL before `npx cap sync ios`
//      to point the WebView at a live-reload server on your Mac:
//
//        GATI_DEV_SERVER_URL=http://192.168.0.100:5050 npm run ios:sync
//
// Why the default is bundled: when `server.url` IS set, Capacitor loads that URL
// and IGNORES the bundled webDir entirely — there is no fallback.  A stale IP
// (DHCP hands the Mac a new lease) then white-screens the app BEFORE any of our
// JavaScript runs, so the setup screen can never appear to rescue it.  Baking a
// LAN IP into a committed config guarantees that failure sooner or later.
//
// `cleartext: true` is what permits plain http:// to a LAN address at all; it is
// for on-device testing only.  Use HTTPS for anything beyond your own network.
const devServerUrl = process.env.GATI_DEV_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'in.gati.railtracker',
  appName: 'GATI',
  webDir: 'public',
  server: {
    cleartext: true,
    ...(devServerUrl ? { url: devServerUrl } : {}),
  },
};

export default config;
