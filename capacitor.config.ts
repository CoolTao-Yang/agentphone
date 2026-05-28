import type { CapacitorConfig } from '@capacitor/cli';

// agentphone APK — a thin Capacitor wrapper around the PWA hosted on
// the user's local agentphone server (over Tailscale).
//
// `server.url` is baked into the APK at build time. If your machine's
// Tailscale IP changes, edit this file and rebuild. Most users keep
// this IP stable.
//
// Future v2: bundle the static/ assets into the APK and read the
// server URL from a settings screen at runtime — then this file would
// not need editing per-user.

const config: CapacitorConfig = {
  appId: 'com.cooltao.agentphone',
  appName: 'agentphone',
  webDir: 'static',
  android: {
    allowMixedContent: true,
  },
  server: {
    // Bake the Tailscale URL into the APK. `/launch` does the token
    // redirect server-side, so the APK never needs to know the token.
    url: process.env.AGENTPHONE_SERVER_URL || 'http://100.119.115.75:8765/launch',
    // We're using HTTP over Tailscale's encrypted tunnel — Android
    // would normally block cleartext, but Tailscale itself is encrypted
    // so the cleartext-over-loopback-tunnel is fine. Set to false
    // (and switch to https:// via `tailscale serve`) once HTTPS is
    // enabled.
    cleartext: true,
  },
};

export default config;
