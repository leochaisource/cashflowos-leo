import type { MetadataRoute } from 'next'

// PWA manifest. Next's App Router serves this at /manifest.webmanifest (NOT
// /manifest.json) — which is why proxy.ts excludes that exact path, so
// Add-to-Home-Screen can read it without the passcode. `display: standalone`
// makes the installed app open full-screen, like a native app. Icons are the
// SpeakFunnels exports (Signal Blue tile, white bars, Signal Light dot).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SpeakFunnels Command Centre',
    short_name: 'Command Centre',
    description: 'Every project, funnel and robot in one place.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0B0B1A',
    theme_color: '#0B0B1A',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
