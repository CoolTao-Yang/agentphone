import type { CapacitorConfig } from '@capacitor/cli';

// agentphone APK — bundles the static/ assets and lets the user enter
// their server URL on first launch (stored in localStorage; persists
// across restarts). No more rebuilding the APK every time the host's
// Tailscale IP shifts.
//
// On launch (v38+ OTA UI):
//   1. WebView loads bundled index.html (at http://localhost).
//   2. Inline bootstrap script checks localStorage for saved URL+token.
//   3. If saved → probe server with a 2.5s timeout, then:
//        - reachable → location.replace(<url>/launch) so the user gets
//          the latest server-hosted UI for free (no APK reinstall needed
//          to pick up the desktop-side static/ changes).
//        - unreachable → fall back to bundled UI + small "离线模式" toast.
//   4. If not saved → setup form (manual URL or QR scan), then redirects
//      to <url>/launch on commit. The server's /launch route attaches the
//      current token automatically, so token rotation handles itself.

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
    // Without this Capacitor's WebView dumps any non-localhost navigation
    // to the system browser — which would break the bootstrap → user-
    // configured server URL flow. '*' is safe here because the user
    // explicitly enters the URL on first launch.
    allowNavigation: ['*'],
  },
};

export default config;
