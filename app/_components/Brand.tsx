import Link from 'next/link'

// The SpeakFunnels mark, drawn to the brand book's construction (Brand
// Guidelines v1.0 §02): three full-pill bars, bar height 1x, gap 0.3x, widths
// 4.8x → 3x → 1.2x, centred. The first two bars are Signal Blue; the last bar
// takes the surface's ink (Ink on light, white on dark) through --mark-c, so it
// never needs recolouring by hand. Inline SVG rather than a /public file, so the
// passcode gate in proxy.ts can never turn it into a blank box.
export function Mark({ width = 24 }: { width?: number }) {
  return (
    <svg className="sf-mark" width={width} height={(width * 36) / 48} viewBox="0 0 48 36" aria-hidden="true">
      <rect x="0" y="0" width="48" height="10" rx="5" fill="var(--mark-a)" />
      <rect x="9" y="13" width="30" height="10" rx="5" fill="var(--mark-a)" />
      <rect x="18" y="26" width="12" height="10" rx="5" fill="var(--mark-c)" />
    </svg>
  )
}

// The lockup: mark + "SpeakFunnels" wordmark (Sora, tracked tight; "Funnels"
// in Signal Blue on light, Signal Light on dark) + the product name underneath.
export default function Brand({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <Link href="/" className={`brand brand-${size}`} aria-label="SpeakFunnels Command Centre, home">
      <Mark width={size === 'lg' ? 34 : 24} />
      <span className="brand-text">
        <span className="wordmark">
          Speak<span className="wm-b">Funnels</span>
        </span>
        <span className="brand-sub">Command Centre</span>
      </span>
    </Link>
  )
}
