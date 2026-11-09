import { useAppApi } from '@kirocrew/app-sdk'
import { Btn, EmptyState, ErrorNotice, Input, PageHeader, SegmentedControl } from '@kirocrew/app-sdk/ui'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import IssueDetail from './IssueDetail'
import IssueTable from './IssueTable'
import Kanban from './Kanban'
import ListFilters from './ListFilters'
import SearchBar from './SearchBar'
import SettingsTab from './SettingsTab'
import { useStrings } from './strings'
import type { Meta, ProjectOptions, ResultMeta, SavedView, SettingsView } from './types'
import {
  API, DEFAULT_VIEW, MY_TOKEN, addToken, errCode, errMessage, hasToken, loadViewState, projectOf, qs,
  removeToken, saveViewState, setField, setProject, tabOf, toggleToken, type ViewState,
} from './util'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
})

type Tab = 'board' | 'list' | 'settings'

function Page() {
  const api = useAppApi()
  const qc = useQueryClient()
  const S = useStrings()
  const [view, setViewState] = useState<ViewState>(loadViewState)
  const [tab, setTabState] = useState<Tab>(() => (loadViewState().tab as Tab) || 'board')
  const [expr, setExpr] = useState(view.expr)
  const [draft, setDraft] = useState(view.expr)
  const [selected, setSelected] = useState<number | null>(null)
  const [resultMeta, setResultMeta] = useState<ResultMeta | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const visibleIds = useRef<number[]>([])

  const setView = (v: Partial<ViewState> & { tab?: Tab }) => {
    const next = { ...view, ...v }
    setViewState(next)
    saveViewState({ expr: next.expr, tab: next.tab, sort: next.sort })
    if (v.expr !== undefined) setExpr(v.expr)
  }

  const applyExpr = (e: string) => {
    setExpr(e)
    setViewState((v) => {
      const next = { ...v, expr: e }
      saveViewState(next)
      return next
    })
  }

  const submit = useCallback(() => applyExpr(draft.trim()), [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  // debounce: search as you type (400ms)
  useEffect(() => {
    const t = setTimeout(() => {
      if (draft.trim() !== expr) applyExpr(draft.trim())
    }, 400)
    return () => clearTimeout(t)
  }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  const setTab = (t: Tab) => {
    setTabState(t)
    if (t !== 'settings') setView({ tab: t })
  }

  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsView>(`${API}/settings`) })
  const configured = !!settingsQ.data?.baseUrl && !!settingsQ.data?.apiKeySet
  const metaQ = useQuery({
    queryKey: ['meta', settingsQ.data?.baseUrl],
    queryFn: () => api.get<Meta>(`${API}/meta`),
    enabled: configured,
    staleTime: 5 * 60_000,
  })
  const meta = metaQ.data
  const viewsQ = useQuery({
    queryKey: ['views'],
    queryFn: () => api.get<{ views: SavedView[] }>(`${API}/views`),
    enabled: configured,
    staleTime: 30_000,
  })

  // project for scoped suggestions: only the project: token. Without one,
  // suggest members of the user's own projects instead of an arbitrary project.
  const projectRef = useMemo(() => {
    const ident = projectOf(expr)
    return ident ? meta?.projects.find((p) => p.identifier === ident || String(p.id) === ident) : undefined
  }, [meta, expr])
  const optionsQ = useQuery({
    queryKey: ['options', projectRef?.identifier],
    queryFn: () => api.get<ProjectOptions>(`${API}/options${qs({ project: projectRef?.identifier })}`),
    enabled: configured && !!projectRef,
    staleTime: 5 * 60_000,
  })
  const myMembersQ = useQuery({
    queryKey: ['members', 'mine'],
    queryFn: () => api.get<{ members: ProjectOptions['members'] }>(`${API}/members`),
    enabled: configured && !projectRef,
    staleTime: 5 * 60_000,
  })
  const suggestOptions: ProjectOptions | undefined = projectRef
    ? optionsQ.data
    : myMembersQ.data && { members: myMembersQ.data.members, versions: [], categories: [], customFields: [] }

  const myProjectIds = useMemo(() => new Set(meta?.myProjectIds ?? []), [meta])
  const projectChoices = useMemo(() => {
    const all = meta?.projects ?? []
    return {
      mine: all.filter((p) => myProjectIds.has(p.id)),
      others: all.filter((p) => !myProjectIds.has(p.id)),
    }
  }, [meta, myProjectIds])
  const setExprNow = (next: string) => {
    setDraft(next)
    applyExpr(next)
  }

  const addFilterToken = useCallback((token: string) => {
    const next = addToken(expr, token)
    setDraft(next)
    applyExpr(next)
  }, [expr]) // eslint-disable-line react-hooks/exhaustive-deps

  const editChip = (raw: string) => {
    const next = removeToken(expr, raw)
    applyExpr(next)
    setDraft(next ? `${next} ${raw}` : raw)
    searchRef.current?.focus()
  }
  const removeChip = (raw: string) => {
    const next = removeToken(expr, raw)
    setDraft(next)
    applyExpr(next)
  }

  const saveView = (name: string) => {
    api.post(`${API}/views`, { name, view: { expr, tab, sort: view.sort } }).then(() => {
      qc.invalidateQueries({ queryKey: ['views'] })
    })
  }
  const applyView = (v: SavedView | null) => {
    if (!v) {
      setDraft('')
      applyExpr('')
      return
    }
    const e = v.expr ?? ''
    setDraft(e)
    applyExpr(e)
    if (v.tab) setTab(v.tab)
    if (v.sort) setView({ sort: v.sort })
  }
  const deleteView = (name: string) => {
    api.post(`${API}/views/delete`, { name }).then(() => qc.invalidateQueries({ queryKey: ['views'] }))
  }

  const onResult = useCallback((r: ResultMeta) => setResultMeta(r), [])
  const onVisible = useCallback((ids: number[]) => {
    visibleIds.current = ids
  }, [])

  // keyboard shortcuts (SPEC §7.5)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable
      if (e.key === 'Escape') {
        if (helpOpen) setHelpOpen(false)
        else if (selected != null) setSelected(null)
        else (document.activeElement as HTMLElement)?.blur()
        return
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'b' || e.key === 'B') {
        setTab(tab === 'board' ? 'list' : 'board')
      } else if (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K') {
        const ids = visibleIds.current
        if (!ids.length) return
        const dir = e.key.toLowerCase() === 'j' ? 1 : -1
        const cur = selected == null ? -1 : ids.indexOf(selected)
        const next = ids[Math.min(ids.length - 1, Math.max(0, cur + dir))]
        if (next != null) setSelected(next)
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        searchRef.current?.focus()
        setDraft((d) => (d.endsWith(' ') || !d ? d : `${d} `))
      } else if (e.key === '?') {
        setHelpOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [tab, selected, helpOpen])

  const notConfigured = !settingsQ.isLoading && (!configured || errCode(metaQ.error) === 'not_configured')
  const em = (e: unknown) => errMessage(e, S.errorFor, S.errorGeneric)

  return (
    <>
      <PageHeader
        title={S.appTitle}
        subtitle={meta ? `${S.appSubtitle} · ${meta.user.name} @ ${meta.baseUrl}` : S.appSubtitle}
        actions={
          <SegmentedControl<Tab>
            segments={[
              { key: 'board', label: S.tabBoard },
              { key: 'list', label: S.tabList },
              { key: 'settings', label: S.tabSettings },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel={S.appTitle}
          />
        }
      />
      <div className="px-6 pb-8 overflow-y-auto flex-1 min-h-0">
        {settingsQ.error ? <ErrorNotice message={em(settingsQ.error)} /> : null}
        {tab === 'settings' ? (
          <SettingsTab settings={settingsQ.data} meta={meta} />
        ) : notConfigured ? (
          <EmptyState
            icon="🔌"
            title={S.settingsNotConfigured}
            subtitle={S.settingsNotConfiguredHint}
            action={<Btn primary onClick={() => setTab('settings')}>{S.openSettings}</Btn>}
          />
        ) : (
          <>
            {metaQ.error ? <ErrorNotice message={em(metaQ.error)} /> : null}
            {tab === 'list' ? (
              <ListFilters
                expr={expr}
                setExpr={setExprNow}
                meta={meta}
                members={suggestOptions?.members ?? []}
                views={viewsQ.data?.views ?? []}
                onApplyView={applyView}
                onSaveView={saveView}
                advancedOpen={advancedOpen}
                onToggleAdvanced={() => setAdvancedOpen((o) => !o)}
              />
            ) : null}
            {tab === 'list' ? null : (
            <div className="flex items-center gap-2" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
              <Btn
                type="button"
                primary={hasToken(expr, MY_TOKEN)}
                aria-pressed={hasToken(expr, MY_TOKEN)}
                title={S.mineHint}
                onClick={() => setExprNow(toggleToken(expr, MY_TOKEN))}
              >
                {S.mineOnly}
              </Btn>
              <select
                aria-label={S.projectFilter}
                value={projectRef?.identifier ?? ''}
                onChange={(e) => setExprNow(setProject(expr, e.target.value || null))}
                style={{ fontSize: 13, padding: '4px 6px', maxWidth: 260 }}
              >
                <option value="">{S.projectAll}</option>
                {projectChoices.mine.length ? (
                  <optgroup label={S.projectMine}>
                    {projectChoices.mine.map((p) => (
                      <option key={p.id} value={p.identifier}>{p.name}</option>
                    ))}
                  </optgroup>
                ) : null}
                {projectChoices.others.length ? (
                  <optgroup label={S.projectOthers}>
                    {projectChoices.others.map((p) => (
                      <option key={p.id} value={p.identifier}>{p.name}</option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </div>
            )}
            {tab === 'list' && !advancedOpen ? null : (
            <SearchBar
              draft={draft}
              setDraft={setDraft}
              onSubmit={submit}
              meta={meta}
              options={suggestOptions}
              chips={resultMeta?.chips ?? []}
              errors={resultMeta?.errors ?? []}
              onEditChip={editChip}
              onRemoveChip={removeChip}
              views={viewsQ.data?.views ?? []}
              onApplyView={applyView}
              onSaveView={saveView}
              onDeleteView={deleteView}
              inputRef={searchRef}
            />
            )}
            {resultMeta?.note === 'partial' || resultMeta?.note === 'partial_negation' ? (
              <p className="text-sm text-muted" style={{ marginBottom: 8 }}>{S.partialNote}</p>
            ) : null}
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                {tab === 'board' ? (
                  <Kanban
                    expr={expr}
                    sort={view.sort}
                    selectedId={selected}
                    onSelect={setSelected}
                    onAddToken={addFilterToken}
                    onVisible={onVisible}
                    onResult={onResult}
                  />
                ) : (
                  <IssueTable
                    expr={expr}
                    sort={view.sort}
                    onSort={(s) => setView({ sort: s })}
                    selectedId={selected}
                    onSelect={setSelected}
                    onVisible={onVisible}
                    onResult={onResult}
                    showAuthor={tabOf(expr) === 'mine'}
                    onSetFilter={(field, value) => setExprNow(setField(expr, field, value))}
                  />
                )}
              </div>
              {selected != null ? (
                <IssueDetail
                  key={selected}
                  id={selected}
                  user={meta?.user}
                  onClose={() => setSelected(null)}
                  onOpenIssue={(id) => setSelected(id)}
                />
              ) : null}
            </div>
          </>
        )}
      </div>
      {helpOpen ? (
        <div
          role="dialog"
          aria-label={S.helpTitle}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 50,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setHelpOpen(false)}
        >
          <div style={{ ...{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }, padding: 20, maxWidth: 420 }}>
            <h3 style={{ marginTop: 0 }}>{S.helpTitle}</h3>
            <table style={{ fontSize: 13, borderCollapse: 'collapse' }}>
              <tbody>
                {S.shortcuts.map(([k, d]) => (
                  <tr key={k}>
                    <td style={{ padding: '3px 12px 3px 0', fontFamily: 'monospace' }}>{k}</td>
                    <td style={{ padding: 3 }}>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  )
}

export default function RedmineBoard() {
  return (
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>
  )
}
