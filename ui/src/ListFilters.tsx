// List view controls: preset tabs with counts, field dropdowns, keyword box.
// Every control rewrites the query expression, so saved views and Kiro's
// search keep working on the same expression the advanced box shows.
import { useAppApi } from '@kirocrew/app-sdk'
import { Btn, Input } from '@kirocrew/app-sdk/ui'
import { useQueries } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import ProjectPicker from './ProjectPicker'
import { useStrings } from './strings'
import type { Meta, ProjectOptions, SavedView, SearchResult } from './types'
import {
  API, LIST_TABS, fieldValue, keywordOf, projectOf, qs, setField, setKeyword, setProject,
  tabOf, withTab, type ListTab,
} from './util'

const selectStyle = { fontSize: 13, padding: '4px 6px', maxWidth: 240 }

export default function ListFilters({
  expr,
  setExpr,
  meta,
  members,
  views,
  onApplyView,
  onSaveView,
  advancedOpen,
  onToggleAdvanced,
}: {
  expr: string
  setExpr: (next: string) => void
  meta: Meta | undefined
  members: ProjectOptions['members']
  views: SavedView[]
  onApplyView: (v: SavedView) => void
  onSaveView: (name: string) => void
  advancedOpen: boolean
  onToggleAdvanced: () => void
}) {
  const api = useAppApi()
  const S = useStrings()
  const tab = tabOf(expr)
  const myIds = useMemo(() => new Set(meta?.myProjectIds ?? []), [meta])

  // tab counts: one limit=1 query per tab, same filters as the list
  const counts = useQueries({
    queries: LIST_TABS.map((t) => ({
      queryKey: ['tabCount', withTab(expr, t)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<SearchResult>(`${API}/issues${qs({ query: withTab(expr, t), limit: 1 })}`, { signal }),
      staleTime: 30_000,
    })),
  })
  const tabLabel: Record<ListTab, string> = {
    mine: S.tabMine, requested: S.tabRequested, overdue: S.tabOverdue, all: S.tabAll,
  }

  // keyword box: local text, applied after a pause or on Enter
  const kw = keywordOf(expr)
  const [text, setText] = useState(kw)
  useEffect(() => setText(kw), [kw])
  useEffect(() => {
    if (text.trim() === kw) return
    const t = setTimeout(() => setExpr(setKeyword(expr, text.trim())), 400)
    return () => clearTimeout(t)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  const [saving, setSaving] = useState(false)
  const [viewName, setViewName] = useState('')

  const project = projectOf(expr)
  const status = fieldValue(expr, 'status') ?? ''
  const assignee = fieldValue(expr, 'assignee') ?? ''
  const tracker = fieldValue(expr, 'tracker') ?? ''
  const noSubprojects = fieldValue(expr, 'subproject') === 'none'

  // keep a value typed in the advanced box selectable instead of blanking it
  const known = (v: string, ids: string[]) => !v || ids.includes(v)

  return (
    <div style={{ marginBottom: 8 }}>
      <div role="tablist" aria-label={S.tabList} className="flex items-center gap-2" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        {LIST_TABS.map((t, i) => (
          <Btn
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            primary={tab === t}
            onClick={() => setExpr(withTab(expr, t))}
          >
            {tabLabel[t]}
            {counts[i].data ? ` ${counts[i].data.total}` : ''}
          </Btn>
        ))}
      </div>

      <div className="flex items-center gap-2" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <ProjectPicker
          projects={meta?.projects ?? []}
          myIds={myIds}
          value={project}
          onChange={(ident) => setExpr(setProject(setField(expr, 'subproject', null), ident))}
          includeSubprojects={!noSubprojects}
          onIncludeSubprojects={(v) => setExpr(setField(expr, 'subproject', v ? null : 'none'))}
        />

        <select
          aria-label={S.filterStatus}
          value={status}
          onChange={(e) => setExpr(setField(expr, 'status', e.target.value || null))}
          style={selectStyle}
        >
          <option value="">{S.statusOpen}</option>
          <option value="closed">{S.statusClosed}</option>
          <option value="*">{S.statusAny}</option>
          {!known(status, ['closed', '*', 'open', ...(meta?.statuses ?? []).map((s) => String(s.id))]) ? (
            <option value={status}>{status}</option>
          ) : null}
          {(meta?.statuses ?? []).map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
        </select>

        <select
          aria-label={S.filterAssignee}
          value={assignee}
          onChange={(e) => setExpr(setField(expr, 'assignee', e.target.value || null))}
          style={selectStyle}
        >
          <option value="">{S.assigneeAny}</option>
          <option value="me">{S.assigneeMe}</option>
          <option value="none">{S.unassigned}</option>
          {!known(assignee, ['me', 'none', ...members.map((m) => String(m.id))]) ? (
            <option value={assignee}>{assignee}</option>
          ) : null}
          {members.map((m) => (
            <option key={m.id} value={String(m.id)}>{m.group ? `👥 ${m.name}` : m.name}</option>
          ))}
        </select>

        <select
          aria-label={S.filterTracker}
          value={tracker}
          onChange={(e) => setExpr(setField(expr, 'tracker', e.target.value || null))}
          style={selectStyle}
        >
          <option value="">{S.trackerAny}</option>
          {!known(tracker, (meta?.trackers ?? []).map((t) => String(t.id))) ? (
            <option value={tracker}>{tracker}</option>
          ) : null}
          {(meta?.trackers ?? []).map((t) => <option key={t.id} value={String(t.id)}>{t.name}</option>)}
        </select>
      </div>

      <form
        className="flex items-center gap-2"
        role="search"
        style={{ flexWrap: 'wrap' }}
        onSubmit={(e) => {
          e.preventDefault()
          setExpr(setKeyword(expr, text.trim()))
        }}
      >
        <div style={{ flex: '1 1 360px', minWidth: 240 }}>
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={S.keywordPlaceholder}
            aria-label={S.keywordPlaceholder}
            style={{ width: '100%' }}
          />
        </div>
        <Btn type="button" onClick={onToggleAdvanced} aria-expanded={advancedOpen}>
          {advancedOpen ? S.advancedHide : S.advanced}
        </Btn>
        <select
          aria-label={S.savedViews}
          value=""
          onChange={(e) => {
            const v = views[Number(e.target.value)]
            if (v) onApplyView(v)
            e.target.value = ''
          }}
          style={{ ...selectStyle, maxWidth: 160 }}
        >
          <option value="">{S.savedViews}</option>
          {views.map((v, i) => <option key={v.name} value={i}>{v.name}</option>)}
        </select>
        <Btn type="button" onClick={() => setSaving((s) => !s)} title={S.viewSaveHint}>{S.viewSave}</Btn>
      </form>

      {saving ? (
        <form
          className="flex items-center gap-2"
          style={{ marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault()
            if (viewName.trim()) {
              onSaveView(viewName.trim())
              setViewName('')
              setSaving(false)
            }
          }}
        >
          <Input
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            placeholder={S.viewNamePlaceholder}
            style={{ width: 220 }}
          />
          <Btn primary type="submit">{S.viewSaveOk}</Btn>
        </form>
      ) : null}
    </div>
  )
}
