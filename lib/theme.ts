// The two Command Centre themes. Shared by the root layout (server: reads the
// sf-theme cookie, sets <html data-theme>, picks the status-bar tint) and the
// ThemeToggle (client: flips it). Dark is the default.
export type Theme = 'dark' | 'light'
export const THEME_COOKIE = 'sf-theme'
export const THEME_COLOR: Record<Theme, string> = { dark: '#0B0B1A', light: '#F4F4F0' }
export const themeFrom = (v: string | undefined): Theme => (v === 'light' ? 'light' : 'dark')
