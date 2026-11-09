import { useAppApi } from '@kirocrew/app-sdk'
import { Badge, Btn, EmptyState, ErrorNotice } from '@kirocrew/app-sdk/ui'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useStrings } from './strings'
import type { ResultMeta, SearchResult } from './types'
import { API, box, errMessage, fmtDay, fmtWhen, priorityTone, qs, shortProjectNames } from './util'

const PAGE = 50
const SORT_KEYS = ['id', 'subject', 'status', 'priority', 'assigned_to', 'author', 'due_date', 'updated_on'] as const
type SortKey = (typeof SORT_KEYS)[number]

export default function IssueTable({
  expr,
  sort,
  onSort,
  selectedId,
  onSelect,
  onVisible,
  onResult,
  showAuthor = false,
  onSetFilter,
}: {
  expr: string
  sort: string
  onSort: (s: string) => void
  selectedId: number | null
  onSelect: (id: number) => void
  onVisible: (ids: number[]) => void
  onResult: (r: ResultMeta) => void
  /** show the author (requester) instead of the assignee, e.g. on "assigned to me" */
  showAuthor?: boolean
  /** click a cell value to filter by it (field, id) */
  onSetFilter?: (field: string, value: string) => void
}) {
  const api = useAppApi()
  const S = useStrings()
  const [offset, setOffset] = useState(0)
  const [key, dir] = (sort || 'updated_on:desc').split(':') as [SortKey, 'asc' | 'desc']

  useEffect(() => setOffset(0), [expr, sort])

  const q = useQuery({
    queryKey: ['issues', expr, sort, offset],
    queryFn: ({ signal }) =>
      api.get<SearchResult>(
        `${API}/issues${qs({ query: expr, sort, offset, limit: PAGE })}`,
        { signal },
      ),
    placeholderData: keepPreviousData,
  })

  const data = q.data
  useEffect(() => {
    if (data) {
      onResult(data)
      onVisible(data.issues.map((i) => i.id))
      if (data.direct && data.issues.length === 1) onSelect(data.direct)
    }
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const projectNames = useMemo(
    () => shortProjectNames((data?.issues ?? []).map((i) => i.project?.name ?? '').filter(Boolean)),
    [data],
  )
  const filterCell = (field: string, ref: { id: number; name: string } | null | undefined) =>
    ref && onSetFilter ? (
      <span
        role="button"
        title={S.clickToSetFilter}
        onClick={(e) => {
          e.stopPropagation()
          onSetFilter(field, String(ref.id))
        }}
        style={{ cursor: 'pointer', textDecoration: 'underline dotted' }}
      >
        {ref.name}
      </span>
    ) : (ref?.name ?? null)

  const header = (k: SortKey | null, label: string, width?: number) => (
    <th
      style={{ textAlign: 'left', padding: '6px 8px', width, cursor: k ? 'pointer' : undefined, whiteSpace: 'nowrap' }}
      aria-sort={k && key === k ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
      onClick={() => k && onSort(`${k}:${key === k && dir === 'desc' ? 'asc' : 'desc'}`)}
    >
      {label}
      {k && key === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  )

  if (q.error) return <ErrorNotice message={errMessage(q.error, S.errorFor, S.errorGeneric)} />
  if (!data) return <p className="text-sm text-muted">{S.loading}</p>
  if (!data.issues.length) return <EmptyState icon="🔍" title={S.noIssues} />

  return (
    <>
    <p className="text-sm" style={{ margin: '0 0 6px', fontWeight: 600 }}>
      {S.totalCount(data.total)}
      {data.total > data.issues.length ? (
        <span className="text-muted" style={{ fontWeight: 400 }}>
          {' '}({S.pageInfo(data.offset + 1, data.offset + data.issues.length, data.total)})
        </span>
      ) : null}
    </p>
    <div style={{ ...box.card, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead style={{ borderBottom: '1px solid var(--border)' }}>
          <tr>
            {header('id', S.colId, 60)}
            {header('subject', S.colSubject)}
            {header('status', S.colStatus, 120)}
            {header('priority', S.colPriority, 100)}
            {showAuthor ? header('author', S.colAuthor, 140) : header('assigned_to', S.colAssignee, 140)}
            {header('due_date', S.colDue, 100)}
            {header(null, S.colProject, 140)}
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
              <td
                style={{ padding: '6px 8px', cursor: onSetFilter ? 'pointer' : undefined }}
                title={onSetFilter ? S.clickToSetFilter : undefined}
                onClick={(e) => {
                  if (!onSetFilter) return
                  e.stopPropagation()
                  onSetFilter('status', String(it.status.id))
                }}
              >
                <Badge variant={it.status.isClosed ? 'muted' : 'aim'}>
                  {it.status.isClosed ? `✓ ${it.status.name}` : it.status.name}
                </Badge>
              </td>
              <td style={{ padding: '6px 8px' }}>
                <Badge variant={priorityTone(it.priority?.name)}>{it.priority?.name ?? '—'}</Badge>
              </td>
              {showAuthor ? (
                <td style={{ padding: '6px 8px' }}>{filterCell('author', it.author) ?? '—'}</td>
              ) : (
                <td style={{ padding: '6px 8px', ...(it.assignedTo ? {} : box.muted) }}>
                  {filterCell('assignee', it.assignedTo) ?? S.unassigned}
                </td>
              )}
              <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', ...(isOverdue(it) ? { color: 'var(--err, #d33)' } : box.muted) }}>
                {it.dueDate ? fmtDay(it.dueDate) : '—'}
              </td>
              <td
                style={{ padding: '6px 8px', ...box.muted, whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={it.project?.name}
              >
                {it.project ? projectNames.get(it.project.name) ?? it.project.name : ''}
              </td>
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
    </>
  )
}

function isOverdue(it: { dueDate: string | null; status: { isClosed: boolean } }): boolean {
  if (!it.dueDate || it.status.isClosed) return false
  const today = new Date()
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return it.dueDate < ymd
}
