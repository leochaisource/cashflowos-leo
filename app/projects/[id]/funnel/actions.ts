'use server'

// The Funnel tab's one write: the owner's own benchmark for a stage. Blank
// clears it, so the stage goes back to the median of the finished events.

import { revalidatePath } from 'next/cache'
import { getProject } from '@/lib/ad-clients'
import { RATES } from '@/lib/funnel-config'
import { supabase, supabaseConfigured } from '@/lib/supabase'

export async function setBenchmark(formData: FormData): Promise<void> {
  const project = String(formData.get('project') ?? '')
  const funnel = String(formData.get('funnel') ?? 'all')
  const rate = String(formData.get('rate') ?? '')
  const raw = String(formData.get('value') ?? '').trim().replace('%', '')
  if (!getProject(project) || !RATES.some((r) => r.key === rate) || !supabaseConfigured) return
  if (!raw) await supabase.from('funnel_benchmarks').delete().eq('project', project).eq('funnel', funnel).eq('rate', rate)
  else {
    const v = Number(raw)
    if (!Number.isFinite(v) || v < 0 || v > 100) return
    await supabase
      .from('funnel_benchmarks')
      .upsert({ project, funnel, rate, value: v / 100, updated_at: new Date().toISOString() }, { onConflict: 'project,funnel,rate' })
  }
  revalidatePath(`/projects/${project}/funnel`)
}
