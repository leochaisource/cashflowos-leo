'use client'

import { useState } from 'react'

// One competitor creative, with a calm fallback.
//
// A thumbnail saved to Supabase Storage is permanent, but an ad found before
// thumbnails were kept may still point at Meta's CDN, whose URLs are signed and
// expire within weeks. When that happens the browser gets a 403 — and a card of
// broken-image icons reads as "this page is broken", not "this creative is old".
// So a failed load swaps to a tile that says what happened and where the
// creative still lives. The whole tile links to the permanent Ad Library page.

export default function AdThumb({
  src,
  href,
  format,
  alt,
}: {
  src: string | null
  href: string
  format: string | null
  alt: string
}) {
  const [failed, setFailed] = useState(false)
  const video = (format ?? '').toUpperCase().includes('VIDEO')
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`vthumb${!src || failed ? ' vdoc vmissing' : ''}`}>
      {src && !failed ? (
        // Plain <img>: next/image would need every Meta CDN host allow-listed,
        // and these are already small thumbnails.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <>
          <span className="vdoc-ico">{video ? '🎬' : '🖼'}</span>
          <span className="vdoc-open">{src ? 'Creative expired — open in Ad Library' : 'No preview — open in Ad Library'}</span>
        </>
      )}
    </a>
  )
}
