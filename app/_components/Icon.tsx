// The nav's line icons: 24×24, 1.75 stroke, drawing in currentColor so they
// take the colour of the link they sit in (active = accent). Inline SVG, not
// files, so nothing here can be caught by the passcode gate in proxy.ts.
export type IconName =
  | 'grid' | 'chart' | 'agency' | 'cash-in' | 'cash-out' | 'leads' | 'customers'
  | 'content' | 'tasks' | 'approvals' | 'bot' | 'vault' | 'settings' | 'more' | 'sun' | 'moon'

const PATHS: Record<IconName, React.ReactNode> = {
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4v16h16" />
      <path d="M8 15l3.5-4 3 2.5L19 8" />
    </>
  ),
  agency: (
    <>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
      <path d="M9.5 20.5v-4h5v4M8.5 7.5h2M13.5 7.5h2M8.5 11.5h2M13.5 11.5h2" />
    </>
  ),
  'cash-in': (
    <>
      <rect x="3" y="6.5" width="18" height="13" rx="2.5" />
      <path d="M3 10.5h18M16 15h2" />
      <path d="M6.5 6.5l8.5-3 1.5 3" />
    </>
  ),
  'cash-out': (
    <>
      <path d="M5.5 3.5h13v17l-2.6-1.7-2.2 1.7-2.2-1.7-2.2 1.7-2.2-1.7-1.6 1.7z" />
      <path d="M9 8.5h6M9 12.5h6" />
    </>
  ),
  leads: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </>
  ),
  customers: (
    <>
      <circle cx="10" cy="8" r="4" />
      <path d="M3 21a7 7 0 0 1 14 0" />
      <path d="M16 11l2 2 4-4" />
    </>
  ),
  content: (
    <>
      <path d="M3.5 10v4a1 1 0 0 0 1 1h2.5l6 4V5l-6 4H4.5a1 1 0 0 0-1 1z" />
      <path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  tasks: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
  approvals: (
    <>
      <path d="M3.5 13l2.8-7.5h11.4l2.8 7.5v5.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="M3.5 13h5l1.5 2.5h4L15.5 13h5" />
    </>
  ),
  bot: (
    <>
      <rect x="4.5" y="8" width="15" height="12" rx="3" />
      <path d="M12 4.5V8M9.5 13v1.5M14.5 13v1.5M2.5 13v3M21.5 13v3" />
      <circle cx="12" cy="3.5" r="1" />
    </>
  ),
  vault: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
}

export default function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
