// Milestone bar for the board: pick a target version of the selected project
// and see how many of its issues are closed, with the due date.
import { useAppApi } from '@kirocrew/app-sdk'
import { useQuery } from '@tanstack/react-query'
import { useStrings } from './strings'
import type { ProjectOptions, VersionProgress } from './types'
import { API, box, daysUntil, fieldValue, fmtDay, qs, setField } from './util'

export default function VersionBar({
  project,
  versions,
  expr,
  setExpr,
}: {
  project: string | null
  versions: ProjectOptions['versions']
  expr: string
  setExpr: (next: string) => void
}) {
  const api = useAppApi()
  const S = useStrings()
  const value = fieldValue(expr, 'version') ?? ''
  const versionId = /^\d+$/.test(value) ? Number(value) : null
  const open = versions.filter((v) => v.status !== 'closed')

  const q = useQuery({
    queryKey: ['version', versionId],
    queryFn: () => api.get<VersionProgress>(`${API}/version${qs({ id: versionId })}`),
    enabled: versionId != null,
    staleTime: 30_000,
  })

  if (!project) {
    return <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>{S.versionPickProject}</p>
  }

  const p = q.data
  const pct = p && p.total ? Math.round((p.closed / p.total) * 100) : 0
  const days = p?.dueDate ? daysUntil(p.dueDate) : null

  return (
    <div
      className="flex items-center gap-3"
      style={{ ...box.card, padding: '8px 12px', marginBottom: 8, flexWrap: 'wrap' }}
    >
      <select
        aria-label={S.versionLabel}
        value={value}
        onChange={(e) => setExpr(setField(expr, 'version', e.target.value || null))}
        style={{ fontSize: 13, padding: '4px 6px', maxWidth: 260 }}
      >
        <option value="">{S.versionAll}</option>
        <option value="none">{S.versionNone}</option>
        {value && value !== 'none' && !open.some((v) => String(v.id) === value) ? (
          <option value={value}>{p?.name ?? value}</option>
        ) : null}
        {open.map((v) => (
          <option key={v.id} value={String(v.id)}>{v.name}</option>
        ))}
      </select>
      {versionId != null && p ? (
        <>
          <div
            role="progressbar"
            aria-label={S.versionProgress}
            aria-valuemin={0}
            aria-valuemax={p.total}
            aria-valuenow={p.closed}
            style={{ flex: '1 1 160px', maxWidth: 320, height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}
          >
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
          </div>
          <span className="text-sm">{S.versionCount(p.closed, p.total, pct)}</span>
          {p.dueDate ? (
            <span className="text-sm" style={days != null && days < 0 && p.closed < p.total ? { color: 'var(--err, #d33)' } : box.muted}>
              {S.versionDue(fmtDay(p.dueDate), days ?? 0)}
            </span>
          ) : (
            <span className="text-sm text-muted">{S.versionNoDue}</span>
          )}
        </>
      ) : versionId != null && q.isLoading ? (
        <span className="text-sm text-muted">{S.loading}</span>
      ) : value === 'none' ? (
        <span className="text-sm text-muted">{S.versionNoneHint}</span>
      ) : open.length === 0 ? (
        <span className="text-sm text-muted">{S.versionEmpty}</span>
      ) : null}
    </div>
  )
}
