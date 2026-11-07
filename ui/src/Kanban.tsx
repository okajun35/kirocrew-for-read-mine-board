import { useAppApi, useNotify } from '@kirocrew/app-sdk'
import { Badge, Btn, ErrorNotice } from '@kirocrew/app-sdk/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useStrings } from './strings'
import type { BoardResult, IssueDetail, IssueSummary, ResultMeta } from './types'
import { API, box, errMessage, fieldToken, priorityTone, qs } from './util'

const PAGE = 30

/** Kanban over the shared expression (SPEC-search-board §7). */
export default function Kanban({
  expr,
  sort,
  selectedId,
  onSelect,
  onAddToken,
  onVisible,
  onResult,
}: {
  expr: string
  sort: string
  selectedId: number | null
  onSelect: (id: number) => void
  onAddToken: (token: string) => void
  onVisible: (ids: number[]) => void
  onResult: (r: ResultMeta) => void
}) {
  const api = useAppApi()
  const notify = useNotify()
  const qc = useQueryClient()
  const S = useStrings()
  const [drag, setDrag] = useState<{ id: number; fromStatus: number; allowed: Set<number> | null } | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [more, setMore] = useState<Record<number, IssueSummary[]>>({})

  const q = useQuery({
    queryKey: ['board', expr, sort],
    queryFn: ({ signal }) =>
      api.get<BoardResult>(`${API}/board${qs({ query: expr, perColumn: PAGE, sort })}`, { signal }),
  })

  useEffect(() => {
    if (q.data) {
      onResult(q.data)
      onVisible(q.data.columns.flatMap((c) => c.issues.map((i) => i.id)))
      setMore({})
    }
  }, [q.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const move = useMutation({
    mutationFn: (v: { id: number; statusId: number }) => api.post(`${API}/issue/status`, v),
    onSuccess: (_d, v) => {
      const name = q.data?.columns.find((c) => c.status.id === v.statusId)?.status.name ?? ''
      notify(S.moved(v.id, name), { type: 'success' })
      setNotice(null)
    },
    onError: (e) => setNotice(errMessage(e, S.errorFor, S.errorGeneric)),
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

  const loadMore = (statusId: number, have: number) => {
    api
      .get<BoardResult>(`${API}/board${qs({ query: expr, perColumn: have + PAGE, statusId, sort })}`)
      .then((r) => {
        const col = r.columns[0]
        if (col) setMore((m) => ({ ...m, [statusId]: col.issues }))
      })
  }

  const clickFilter = (e: React.MouseEvent, field: string, value: string | null | undefined) => {
    e.stopPropagation()
    const t = fieldToken(field, value, e.altKey)
    if (t) onAddToken(t)
  }

  if (q.error) return <ErrorNotice message={errMessage(q.error, S.errorFor, S.errorGeneric)} />
  if (!q.data) return <p className="text-sm text-muted">{S.loading}</p>

  return (
    <div>
      {notice ? <ErrorNotice message={notice} onDismiss={() => setNotice(null)} /> : null}
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
        {q.data.columns.map((col) => {
          const droppable = canDrop(col.status.id)
          const blocked = !!drag && drag.fromStatus !== col.status.id && !!drag.allowed && !droppable
          const issues = more[col.status.id] ?? col.issues
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
                maxHeight: 'calc(100vh - 280px)',
              }}
              title={blocked ? S.dropNotAllowed : droppable ? S.dropHere : undefined}
            >
              <header className="flex items-center gap-2" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                <strong className="text-sm">{col.status.isClosed ? `✓ ${col.status.name}` : col.status.name}</strong>
                <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
                  {S.columnCount(issues.length, col.total)}
                </span>
              </header>
              <div style={{ overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {issues.map((it) => (
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
                      {it.tracker ? (
                        <span
                          role="button"
                          title={S.clickToFilter}
                          onClick={(e) => clickFilter(e, 'tracker', it.tracker?.name)}
                          style={{ ...box.muted, fontSize: 12, cursor: 'pointer' }}
                        >
                          {it.tracker.name}
                        </span>
                      ) : null}
                      <span style={{ marginLeft: 'auto' }} onClick={(e) => clickFilter(e, 'priority', it.priority?.name)}>
                        <Badge variant={priorityTone(it.priority?.name)}>{it.priority?.name ?? '—'}</Badge>
                      </span>
                    </div>
                    <div style={{ lineHeight: 1.4 }}>{it.subject}</div>
                    <div style={{ ...box.muted, fontSize: 12, marginTop: 4 }}>
                      <span
                        role="button"
                        title={S.clickToFilter}
                        onClick={(e) => clickFilter(e, 'assignee', it.assignedTo?.name)}
                        style={{ cursor: 'pointer' }}
                      >
                        👤 {it.assignedTo?.name ?? S.unassigned}
                      </span>
                      {it.project ? ` · ${it.project.name}` : ''}
                    </div>
                  </article>
                ))}
                {issues.length < col.total ? (
                  <Btn onClick={() => loadMore(col.status.id, issues.length)} style={{ fontSize: 12 }}>
                    {S.loadMore(col.total - issues.length)}
                  </Btn>
                ) : null}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
