import { useAppApi } from '@kirocrew/app-sdk'
import { Badge, Btn, EmptyState, ErrorNotice } from '@kirocrew/app-sdk/ui'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useStrings } from './strings'
import type { Filters, SearchResult } from './types'
import { API, box, errMessage, fmtWhen, priorityTone, qs } from './util'

const PAGE = 50
type SortKey = 'id' | 'subject' | 'status' | 'priority' | 'assigned_to' | 'updated_on'

export default function IssueTable({
  filters,
  selectedId,
  onSelect,
}: {
  filters: Filters
  selectedId: number | null
  onSelect: (id: number) => void
}) {
  const api = useAppApi()
  const S = useStrings()
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'updated_on', dir: 'desc' })

  useEffect(() => setOffset(0), [filters, sort])

  const q = useQuery({
    queryKey: ['issues', filters, sort, offset],
    queryFn: ({ signal }) =>
      api.get<SearchResult>(
        `${API}/issues${qs({ ...filters, sort: `${sort.key}:${sort.dir}`, offset, limit: PAGE })}`,
        { signal },
      ),
    placeholderData: keepPreviousData,
  })

  const data = q.data
  useEffect(() => {
    if (data?.direct && data.issues.length === 1) onSelect(data.direct)
  }, [data?.direct]) // eslint-disable-line react-hooks/exhaustive-deps

  const header = (key: SortKey | null, label: string, width?: number) => (
    <th
      style={{ textAlign: 'left', padding: '6px 8px', width, cursor: key ? 'pointer' : undefined, whiteSpace: 'nowrap' }}
      aria-sort={key && sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      onClick={() =>
        key && setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))
      }
    >
      {label}
      {key && sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  )

  if (q.error) return <ErrorNotice message={errMessage(q.error, S.errorGeneric)} />
  if (!data) return <p className="text-sm text-muted">{S.loading}</p>
  if (!data.issues.length) return <EmptyState icon="🔍" title={S.noIssues} />

  return (
    <div style={{ ...box.card, overflow: 'auto' }}>
      {data.note === 'partial' ? <p className="text-sm text-muted" style={{ padding: 8 }}>{S.partialNote}</p> : null}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead style={{ borderBottom: '1px solid var(--border)' }}>
          <tr>
            {header('id', S.colId, 60)}
            {header('subject', S.colSubject)}
            {header('status', S.colStatus, 120)}
            {header('priority', S.colPriority, 100)}
            {header('assigned_to', S.colAssignee, 140)}
            {header(null, S.colProject, 120)}
            {header('updated_on', S.colUpdated, 150)}
          </tr>
        </thead>
        <tbody>
          {data.issues.map((it) => (
            <tr
              key={it.id}
              tabIndex={0}
              onClick={() => onSelect(it.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(it.id))}
              aria-selected={selectedId === it.id}
              style={{
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                background: selectedId === it.id ? 'var(--bg-hover)' : undefined,
              }}
            >
              <td style={{ padding: '6px 8px', ...box.muted }}>#{it.id}</td>
              <td style={{ padding: '6px 8px' }}>
                {it.tracker ? <span style={box.muted}>[{it.tracker.name}] </span> : null}
                {it.subject}
              </td>
              <td style={{ padding: '6px 8px' }}>
                <Badge variant={it.status.isClosed ? 'muted' : 'aim'}>
                  {it.status.isClosed ? `✓ ${it.status.name}` : it.status.name}
                </Badge>
              </td>
              <td style={{ padding: '6px 8px' }}>
                <Badge variant={priorityTone(it.priority?.name)}>{it.priority?.name ?? '—'}</Badge>
              </td>
              <td style={{ padding: '6px 8px', ...(it.assignedTo ? {} : box.muted) }}>
                {it.assignedTo?.name ?? S.unassigned}
              </td>
              <td style={{ padding: '6px 8px', ...box.muted }}>{it.project?.name}</td>
              <td style={{ padding: '6px 8px', ...box.muted, whiteSpace: 'nowrap' }}>{fmtWhen(it.updatedOn)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2" style={{ padding: 8, justifyContent: 'flex-end' }}>
        <span className="text-sm text-muted">
          {S.pageInfo(data.offset + 1, data.offset + data.issues.length, data.total)}
        </span>
        <Btn disabled={offset === 0 || q.isFetching} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          {S.prev}
        </Btn>
        <Btn
          disabled={offset + PAGE >= data.total || q.isFetching}
          onClick={() => setOffset(offset + PAGE)}
        >
          {S.next}
        </Btn>
      </div>
    </div>
  )
}
