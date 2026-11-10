import { useAppApi, useNotify } from '@kirocrew/app-sdk'
import { Badge, Btn, ErrorNotice, SegmentedControl } from '@kirocrew/app-sdk/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useStrings } from './strings'
import type { BoardAxis, BoardColumn, BoardResult, IssueDetail, IssueSummary, Meta, ResultMeta, StageKey } from './types'
import {
  API, box, errMessage, fieldToken, fmtDay, isOverdue, loadAxis, priorityTone, qs, saveAxis, shortProjectNames,
} from './util'

const PAGE = 30
const MAX_PER_COLUMN = 100

type Drag = { it: IssueSummary; allowed: Set<number> | null }
type Pick = { issueId: number; statusIds: number[] }

/** Kanban over the shared expression: stage columns or assignee columns. */
export default function Kanban({
  expr,
  sort,
  selectedId,
  onSelect,
  onAddToken,
  onVisible,
  onResult,
  meta,
  stageMap,
}: {
  expr: string
  sort: string
  selectedId: number | null
  onSelect: (id: number) => void
  onAddToken: (token: string) => void
  onVisible: (ids: number[]) => void
  onResult: (r: ResultMeta) => void
  meta: Meta | undefined
  stageMap: Record<string, StageKey>
}) {
  const api = useAppApi()
  const notify = useNotify()
  const qc = useQueryClient()
  const S = useStrings()
  const [axis, setAxisState] = useState<BoardAxis>(loadAxis)
  const [perColumn, setPerColumn] = useState(PAGE)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pick, setPick] = useState<Pick | null>(null)
  const [showDone, setShowDone] = useState(false)

  const setAxis = (a: BoardAxis) => {
    setAxisState(a)
    saveAxis(a)
  }
  useEffect(() => setPerColumn(PAGE), [expr, axis])

  const q = useQuery({
    queryKey: ['board', expr, sort, axis, perColumn, stageMap],
    queryFn: ({ signal }) =>
      api.get<BoardResult>(`${API}/board${qs({ query: expr, perColumn, sort, axis })}`, { signal }),
  })

  useEffect(() => {
    if (q.data) {
      onResult(q.data)
      onVisible(q.data.columns.flatMap((c) => c.issues.map((i) => i.id)))
    }
  }, [q.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const statusName = useMemo(() => new Map((meta?.statuses ?? []).map((s) => [s.id, s.name])), [meta])
  const projectNames = useMemo(
    () => shortProjectNames((q.data?.columns ?? []).flatMap((c) => c.issues.map((i) => i.project?.name ?? '')).filter(Boolean)),
    [q.data],
  )

  const done = (msg: string) => {
    notify(msg, { type: 'success' })
    setNotice(null)
  }
  const settle = (id: number) => {
    qc.invalidateQueries({ queryKey: ['board'] })
    qc.invalidateQueries({ queryKey: ['issues'] })
    qc.invalidateQueries({ queryKey: ['tabCount'] })
    qc.invalidateQueries({ queryKey: ['version'] })
    qc.invalidateQueries({ queryKey: ['issue', id] })
  }
  const fail = (e: unknown) => setNotice(errMessage(e, S.errorFor, S.errorGeneric))

  const moveStatus = useMutation({
    mutationFn: (v: { id: number; statusId: number }) => api.post(`${API}/issue/status`, v),
    onSuccess: (_d, v) => done(S.moved(v.id, statusName.get(v.statusId) ?? '')),
    onError: fail,
    onSettled: (_d, _e, v) => settle(v.id),
  })
  const moveAssignee = useMutation({
    mutationFn: (v: { id: number; assigneeId: number | null; name: string }) =>
      api.post(`${API}/issue/assignee`, { id: v.id, assigneeId: v.assigneeId }),
    onSuccess: (_d, v) => done(S.reassigned(v.id, v.name)),
    onError: fail,
    onSettled: (_d, _e, v) => settle(v.id),
  })

  const startDrag = (it: IssueSummary) => {
    setPick(null)
    setDrag({ it, allowed: axis === 'assignee' ? new Set() : null })
    if (axis === 'assignee') return
    api
      .get<IssueDetail>(`${API}/issue${qs({ id: it.id })}`)
      .then((d) =>
        setDrag((cur) =>
          cur && cur.it.id === it.id
            ? { ...cur, allowed: new Set((d.allowedStatuses ?? []).map((s) => s.id)) }
            : cur,
        ),
      )
      .catch(() => setDrag((cur) => (cur && cur.it.id === it.id ? { ...cur, allowed: new Set() } : cur)))
  }

  /** statuses of a stage column the dragged issue may move to */
  const targets = (col: BoardColumn): number[] => {
    if (!drag?.allowed) return []
    return (col.statusIds ?? []).filter((id) => id !== drag.it.status.id && drag.allowed!.has(id))
  }
  const sameColumn = (col: BoardColumn) =>
    !!drag &&
    (axis === 'assignee'
      ? (col.assigneeId ?? null) === (drag.it.assignedTo?.id ?? null)
      : (col.statusIds ?? []).includes(drag.it.status.id))
  const canDrop = (col: BoardColumn) =>
    !!drag && !sameColumn(col) && (axis === 'assignee' ? true : targets(col).length > 0)

  const drop = (col: BoardColumn) => {
    if (!drag || !canDrop(col)) return
    const id = drag.it.id
    if (axis === 'assignee') {
      moveAssignee.mutate({ id, assigneeId: col.assigneeId ?? null, name: columnTitle(col) })
      return
    }
    const t = targets(col)
    if (t.length === 1) moveStatus.mutate({ id, statusId: t[0] })
    else setPick({ issueId: id, statusIds: t })
  }

  const clickFilter = (e: React.MouseEvent, field: string, value: string | null | undefined) => {
    e.stopPropagation()
    const t = fieldToken(field, value, e.altKey)
    if (t) onAddToken(t)
  }

  const stageTitle: Record<StageKey, string> = {
    todo: S.stageTodo, doing: S.stageDoing, review: S.stageReview, done: S.stageDone,
  }
  const columnTitle = (col: BoardColumn) => {
    if (axis === 'stage') return stageTitle[col.key as StageKey] ?? col.key
    if (col.assigneeId == null) return S.unassigned
    return col.assigneeId === meta?.user.id ? S.assigneeColumnMe(col.name ?? '') : col.name ?? ''
  }

  if (q.error) return <ErrorNotice message={errMessage(q.error, S.errorFor, S.errorGeneric)} />

  const columns = q.data?.columns ?? []
  const canLoadMore = perColumn < MAX_PER_COLUMN && columns.some((c) => c.issues.length < c.total)

  return (
    <div>
      <div className="flex items-center gap-2" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <SegmentedControl<BoardAxis>
          segments={[
            { key: 'stage', label: S.axisStage },
            { key: 'assignee', label: S.axisAssignee },
          ]}
          value={axis}
          onChange={setAxis}
          ariaLabel={S.axisLabel}
        />
        <span className="text-sm text-muted">{axis === 'stage' ? S.axisStageHint : S.axisAssigneeHint}</span>
      </div>
      {notice ? <ErrorNotice message={notice} onDismiss={() => setNotice(null)} /> : null}
      {q.data?.truncated ? (
        <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>{S.boardTruncated(q.data.totalIssues ?? 0)}</p>
      ) : null}
      {pick ? (
        <div className="flex items-center gap-2" style={{ ...box.card, padding: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span className="text-sm">{S.pickStatus(pick.issueId)}</span>
          {pick.statusIds.map((sid) => (
            <Btn
              key={sid}
              onClick={() => {
                moveStatus.mutate({ id: pick.issueId, statusId: sid })
                setPick(null)
              }}
            >
              {statusName.get(sid) ?? sid}
            </Btn>
          ))}
          <Btn onClick={() => setPick(null)}>{S.cancel}</Btn>
        </div>
      ) : null}
      {!q.data ? (
        <p className="text-sm text-muted">{S.loading}</p>
      ) : !columns.length ? (
        <p className="text-sm text-muted">{S.noIssues}</p>
      ) : (
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
          {columns.map((col) => {
            const droppable = canDrop(col)
            const blocked = !!drag && !sameColumn(col) && !droppable && (axis === 'assignee' || !!drag.allowed)
            const collapsed = axis === 'stage' && col.key === 'done' && !showDone
            return (
              <section
                key={col.key}
                aria-label={columnTitle(col)}
                onDragOver={(e) => {
                  if (droppable) {
                    e.preventDefault()
                    setOver(col.key)
                  }
                }}
                onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(null)
                  drop(col)
                  setDrag(null)
                }}
                style={{
                  ...box.card,
                  background: over === col.key ? 'var(--bg-hover)' : 'var(--bg-elevated, var(--card))',
                  borderStyle: droppable ? 'dashed' : 'solid',
                  borderColor: droppable ? 'var(--accent)' : 'var(--border)',
                  opacity: blocked ? 0.5 : 1,
                  width: collapsed ? 160 : 270,
                  flex: `0 0 ${collapsed ? 160 : 270}px`,
                  display: 'flex',
                  flexDirection: 'column',
                  maxHeight: 'calc(100vh - 320px)',
                }}
                title={blocked ? S.dropNotAllowed : droppable ? S.dropHere : undefined}
              >
                <header className="flex items-center gap-2" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                  <strong className="text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {columnTitle(col)}
                  </strong>
                  <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
                    {S.columnCount(col.issues.length, col.total)}
                  </span>
                </header>
                {axis === 'stage' && col.statusIds && col.statusIds.length > 1 && !collapsed ? (
                  <p className="text-muted" style={{ fontSize: 11, margin: 0, padding: '4px 10px' }}>
                    {col.statusIds.map((id) => statusName.get(id) ?? id).join(' / ')}
                  </p>
                ) : null}
                {collapsed ? (
                  <div style={{ padding: 8 }}>
                    <Btn onClick={() => setShowDone(true)} style={{ fontSize: 12 }}>{S.showDone}</Btn>
                  </div>
                ) : (
                  <div style={{ overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {axis === 'stage' && col.key === 'done' ? (
                      <Btn onClick={() => setShowDone(false)} style={{ fontSize: 12 }}>{S.hideDone}</Btn>
                    ) : null}
                    {col.issues.map((it) => (
                      <Card
                        key={it.id}
                        it={it}
                        axis={axis}
                        selected={selectedId === it.id}
                        projectName={it.project ? projectNames.get(it.project.name) ?? it.project.name : ''}
                        onSelect={onSelect}
                        onDragStart={startDrag}
                        onDragEnd={() => {
                          setDrag(null)
                          setOver(null)
                        }}
                        clickFilter={clickFilter}
                      />
                    ))}
                    {!col.statusIds?.length && axis === 'stage' ? (
                      <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>{S.stageNoStatus}</p>
                    ) : null}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
      {canLoadMore ? (
        <Btn onClick={() => setPerColumn((n) => Math.min(MAX_PER_COLUMN, n + PAGE))} style={{ fontSize: 12 }}>
          {S.loadMoreAll}
        </Btn>
      ) : null}
    </div>
  )
}

function Card({
  it,
  axis,
  selected,
  projectName,
  onSelect,
  onDragStart,
  onDragEnd,
  clickFilter,
}: {
  it: IssueSummary
  axis: BoardAxis
  selected: boolean
  projectName: string
  onSelect: (id: number) => void
  onDragStart: (it: IssueSummary) => void
  onDragEnd: () => void
  clickFilter: (e: React.MouseEvent, field: string, value: string | null | undefined) => void
}) {
  const S = useStrings()
  const late = isOverdue(it)
  return (
    <article
      draggable
      tabIndex={0}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(it.id))
        onDragStart(it)
      }}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(it.id)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(it.id))}
      aria-selected={selected}
      style={{
        ...box.card,
        padding: '8px 10px',
        cursor: 'grab',
        outline: selected ? '2px solid var(--accent)' : undefined,
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
      <div style={{ ...box.muted, fontSize: 12, marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
        {axis === 'stage' ? (
          <span
            role="button"
            title={S.clickToFilter}
            onClick={(e) => clickFilter(e, 'assignee', it.assignedTo?.name)}
            style={{ cursor: 'pointer' }}
          >
            👤 {it.assignedTo?.name ?? S.unassigned}
          </span>
        ) : (
          <span>● {it.status.name}</span>
        )}
        {it.author ? <span title={S.colAuthor}>✍ {it.author.name}</span> : null}
        {it.dueDate ? (
          <span style={late ? { color: 'var(--err, #d33)' } : undefined} title={S.colDue}>
            📅 {fmtDay(it.dueDate)}
          </span>
        ) : null}
        {projectName ? <span title={it.project?.name}>· {projectName}</span> : null}
      </div>
    </article>
  )
}
