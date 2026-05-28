import type { CapacitorConfig } from '@capacitor/cli';

// agentphone APK — bundles the static/ assets and lets the user enter
// their server URL on first launch (stored in localStorage; persists
// across restarts). No more rebuilding the APK every time the host's
// Tailscale IP shifts.
//
// On launch:
//   1. WebView loads bundled index.html.
//   2. Inline bootstrap script checks localStorage for the saved URL.
//   3. If saved → location.replace(<url>/launch).
//   4. If not → renders a small setup form, saves, then redirects.

const config: CapacitorConfig = {
  appId: 'com.cooltao.agentphone',
  appName: 'agentphone',
  webDir: 'static',
  android: {
    // Allow http:// fetches inside the WebView so the user can point at
    // a bare Tailscale-IP server without setting up HTTPS first.
    allowMixedContent: true,
  },
  server: {
    // Serve bundled assets on http:// so loading user's http:// server
    // doesn't get blocked as mixed-content from https://localhost.
    androidScheme: 'http',
    cleartext: true,
  },
};

export default config;
