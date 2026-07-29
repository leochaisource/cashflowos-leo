// Daily ad spend, as bars. Inline SVG — no charting library, nothing to load,
// works in a server component.
//
// Every day in the window gets a bar, including the zeros, because a gap in
// delivery is information: three flat days in the middle of a campaign is
// exactly the thing you want to notice at a glance.

export default function Spark({
  data,
  currency = 'RM',
  height = 44,
}: {
  data: { date: string; spend: number; leads?: number }[]
  currency?: string
  height?: number
}) {
  if (!data.length) return null
  const max = Math.max(...data.map((d) => d.spend), 1)
  const gap = 2
  const w = 100 / data.length

  return (
    <svg
      className="spark"
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      height={height}
      role="img"
      aria-label={`Daily spend for the last ${data.length} days`}
    >
      {data.map((d, i) => {
        // A zero-spend day still gets a 1px sliver so the day exists visually
        // rather than silently closing the gap.
        const h = d.spend > 0 ? Math.max((d.spend / max) * (height - 2), 2) : 1
        const last = i === data.length - 1
        return (
          <rect
            key={d.date}
            x={i * w + gap / 2}
            y={height - h}
            width={Math.max(w - gap, 0.5)}
            height={h}
            rx="0.8"
            fill={d.spend > 0 ? (last ? 'var(--clay-deep)' : 'var(--clay)') : 'var(--line-2)'}
            opacity={d.spend > 0 ? 1 : 0.7}
          >
            <title>{`${d.date}: ${currency} ${d.spend.toFixed(2)}${
              typeof d.leads === 'number' ? ` · ${d.leads} leads` : ''
            }`}</title>
          </rect>
        )
      })}
    </svg>
  )
}
