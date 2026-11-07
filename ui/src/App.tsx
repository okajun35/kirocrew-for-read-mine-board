import { useAppApi } from '@kirocrew/app-sdk'
import { Btn, EmptyState, ErrorNotice, Input, PageHeader, SegmentedControl, Select } from '@kirocrew/app-sdk/ui'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import IssueDetail from './IssueDetail'
import IssueTable from './IssueTable'
import Kanban from './Kanban'
import SettingsTab from './SettingsTab'
import { useStrings } from './strings'
import type { Filters, Meta, SettingsView } from './types'
import { API, DEFAULT_FILTERS, errCode, errMessage, loadFilters, qs, saveFilters } from './util'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
})

type Tab = 'board' | 'list' | 'settings'
const TAB_KEY = 'redmine-board:tab'

function Page() {
  const api = useAppApi()
  const S = useStrings()
  const [tab, setTabState] = useState<Tab>(() => (localStorage.getItem(TAB_KEY) as Tab) || 'board')
  const setTab = (t: Tab) => {
    setTabState(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      /* ignore */
    }
  }
  const [filters, setFiltersState] = useState<Filters>(loadFilters)
  const [draftQ, setDraftQ] = useState(filters.q)
  const [selected, setSelected] = useState<number | null>(null)
  const setFilters = (f: Filters) => {
    setFiltersState(f)
    saveFilters(f)
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
  const projectRef = useMemo(
    () => meta?.projects.find((p) => p.identifier === filters.project || String(p.id) === filters.project),
    [meta, filters.project],
  )
  const membersQ = useQuery({
    queryKey: ['members', projectRef?.identifier],
    queryFn: () =>
      api.get<{ members: { id: number; name: string; group: boolean }[] }>(
        `${API}/members${qs({ project: projectRef?.identifier })}`,
      ),
    enabled: configured && !!projectRef,
    staleTime: 5 * 60_000,
  })

  useEffect(() => setDraftQ(filters.q), [filters.q])

  const submitSearch = () => setFilters({ ...filters, q: draftQ.trim() })

  const assigneeOptions = ['', 'me', 'none', ...(membersQ.data?.members ?? []).map((m) => String(m.id))]
  const assigneeLabels = [
    S.assigneeAny,
    S.assigneeMe,
    S.assigneeNone,
    ...(membersQ.data?.members ?? []).map((m) => (m.group ? `👥 ${m.name}` : m.name)),
  ]

  const searchBar = (
    <form
      className="flex items-center gap-2"
      style={{ flexWrap: 'wrap', marginBottom: 12 }}
      onSubmit={(e) => {
        e.preventDefault()
        submitSearch()
      }}
      role="search"
    >
      <Input
        value={draftQ}
        onChange={(e) => setDraftQ(e.target.value)}
        placeholder={S.searchPlaceholder}
        aria-label={S.searchPlaceholder}
        style={{ minWidth: 260, flex: '1 1 260px' }}
      />
      <Btn primary type="submit">{S.searchButton}</Btn>
      <Select
        aria-label={S.filterProject}
        options={['', ...(meta?.projects ?? []).map((p) => p.identifier)]}
        optionLabels={[S.filterAllProjects, ...(meta?.projects ?? []).map((p) => p.name)]}
        value={filters.project}
        onChange={(v) => setFilters({ ...filters, project: v, assignee: ['', 'me', 'none'].includes(filters.assignee) ? filters.assignee : '' })}
        className="min-w-[180px]"
      />
      {tab === 'list' ? (
        <Select
          aria-label={S.filterStatus}
          options={['open', 'closed', '*', ...(meta?.statuses ?? []).map((s) => String(s.id))]}
          optionLabels={[S.statusOpen, S.statusClosed, S.statusAll, ...(meta?.statuses ?? []).map((s) => s.name)]}
          value={filters.status}
          onChange={(v) => setFilters({ ...filters, status: v })}
        />
      ) : null}
      <Select
        aria-label={S.filterAssignee}
        options={assigneeOptions}
        optionLabels={assigneeLabels}
        value={filters.assignee}
        onChange={(v) => setFilters({ ...filters, assignee: v })}
      />
      {JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) ? (
        <Btn type="button" onClick={() => setFilters(DEFAULT_FILTERS)}>{S.clearFilters}</Btn>
      ) : null}
    </form>
  )

  const notConfigured =
    !settingsQ.isLoading && (!configured || errCode(metaQ.error) === 'not_configured')

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
        {settingsQ.error ? <ErrorNotice message={errMessage(settingsQ.error, S.errorGeneric)} /> : null}
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
            {metaQ.error ? <ErrorNotice message={errMessage(metaQ.error, S.errorGeneric)} /> : null}
            {searchBar}
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                {tab === 'board' ? (
                  <Kanban filters={filters} selectedId={selected} onSelect={setSelected} />
                ) : (
                  <IssueTable filters={filters} selectedId={selected} onSelect={setSelected} />
                )}
              </div>
              {selected != null ? <IssueDetail key={selected} id={selected} onClose={() => setSelected(null)} /> : null}
            </div>
          </>
        )}
      </div>
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
