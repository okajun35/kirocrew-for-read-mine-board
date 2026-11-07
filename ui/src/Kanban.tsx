import { useAppApi, useNotify } from '@kirocrew/app-sdk'
import { Badge, ErrorNotice } from '@kirocrew/app-sdk/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useStrings } from './strings'
import type { BoardResult, Filters, IssueDetail, IssueSummary } from './types'
import { API, box, errMessage, priorityTone, qs } from './util'

/**
 * One column per Redmine status. Drag & drop (SPEC F-04 Should): on drag
 * start the issue's allowed_statuses are fetched, only those columns accept
 * the drop, and the server re-reads the issue to confirm the change.
 */
export default function Kanban({
  filters,
  selectedId,
  onSelect,
}: {
  filters: Filters
  selectedId: number | null
  onSelect: (id: number) => void
}) {
  const api = useAppApi()
  const notify = useNotify()
  const qc = useQueryClient()
  const S = useStrings()
  const { status: _ignored, ...boardFilters } = filters
  const [drag, setDrag] = useState<{ id: number; fromStatus: number; allowed: Set<number> | null } | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['board', boardFilters],
    queryFn: ({ signal }) => api.get<BoardResult>(`${API}/board${qs({ ...boardFilters, perColumn: 30 })}`, { signal }),
  })

  const move = useMutation({
    mutationFn: (v: { id: number; statusId: number }) => api.post(`${API}/issue/status`, v),
    onSuccess: (_d, v) => {
      const name = q.data?.columns.find((c) => c.status.id === v.statusId)?.status.name ?? ''
      notify(S.moved(v.id, name), { type: 'success' })
      setNotice(null)
    },
    onError: (e) => setNotice(errMessage(e, S.errorGeneric)),
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ['board'] })
      qc.invalidateQueries({ queryKey: ['issues'] })
      qc.invalidateQueries({ queryKey: ['issue', v.id] })
    },
  })

  const startDrag = (it: IssueSummary) => {
    setDrag({ id: it.id, fromStatus: it.status.id, allowed: null })
    api
      .get<IssueDetail>(`${API}/issue${qs({ id: it.id })}`)
      .then((d) =>
        setDrag((cur) =>
          cur && cur.id === it.id
            ? { ...cur, allowed: d.allowedStatuses ? new Set(d.allowedStatuses.map((s) => s.id)) : new Set() }
            : cur,
        ),
      )
      .catch(() => setDrag((cur) => (cur && cur.id === it.id ? { ...cur, allowed: new Set() } : cur)))
  }

  const canDrop = (statusId: number) =>
    !!drag && drag.fromStatus !== statusId && !!drag.allowed && drag.allowed.has(statusId)

  if (q.error) return <ErrorNotice message={errMessage(q.error, S.errorGeneric)} />
  if (!q.data) return <p className="text-sm text-muted">{S.loading}</p>

  return (
    <div>
      {notice ? <ErrorNotice message={notice} onDismiss={() => setNotice(null)} /> : null}
      {q.data.note === 'partial' ? <p className="text-sm text-muted">{S.partialNote}</p> : null}
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
        {q.data.columns.map((col) => {
          const droppable = canDrop(col.status.id)
          const blocked = !!drag && drag.fromStatus !== col.status.id && !!drag.allowed && !droppable
          return (
            <section
              key={col.status.id}
              aria-label={col.status.name}
              onDragOver={(e) => {
                if (droppable) {
                  e.preventDefault()
                  setOver(col.status.id)
                }
              }}
              onDragLeave={() => setOver((o) => (o === col.status.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault()
                setOver(null)
                if (drag && droppable) move.mutate({ id: drag.id, statusId: col.status.id })
                setDrag(null)
              }}
              style={{
                ...box.card,
                background: over === col.status.id ? 'var(--bg-hover)' : 'var(--bg-elevated, var(--card))',
                borderStyle: droppable ? 'dashed' : 'solid',
                borderColor: droppable ? 'var(--accent)' : 'var(--border)',
                opacity: blocked ? 0.5 : 1,
                minWidth: 260,
                width: 260,
                flex: '0 0 260px',
                display: 'flex',
                flexDirection: 'column',
                maxHeight: 'calc(100vh - 260px)',
              }}
              title={blocked ? S.dropNotAllowed : droppable ? S.dropHere : undefined}
            >
              <header className="flex items-center gap-2" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                <strong className="text-sm">{col.status.isClosed ? `✓ ${col.status.name}` : col.status.name}</strong>
                <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
                  {S.columnCount(col.issues.length, col.total)}
                </span>
              </header>
              <div style={{ overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {col.issues.map((it) => (
                  <article
                    key={it.id}
                    draggable
                    tabIndex={0}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(it.id))
                      startDrag(it)
                    }}
                    onDragEnd={() => {
                      setDrag(null)
                      setOver(null)
                    }}
                    onClick={() => onSelect(it.id)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(it.id))}
                    aria-selected={selectedId === it.id}
                    style={{
                      ...box.card,
                      padding: '8px 10px',
                      cursor: 'grab',
                      outline: selectedId === it.id ? '2px solid var(--accent)' : undefined,
                      fontSize: 13,
                    }}
                  >
                    <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                      <span style={box.muted}>#{it.id}</span>
                      {it.tracker ? <span style={{ ...box.muted, fontSize: 12 }}>{it.tracker.name}</span> : null}
                      <span style={{ marginLeft: 'auto' }}>
                        <Badge variant={priorityTone(it.priority?.name)}>{it.priority?.name ?? '—'}</Badge>
                      </span>
                    </div>
                    <div style={{ lineHeight: 1.4 }}>{it.subject}</div>
                    <div style={{ ...box.muted, fontSize: 12, marginTop: 4 }}>
                      👤 {it.assignedTo?.name ?? S.unassigned}
                      {it.project ? ` · ${it.project.name}` : ''}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
