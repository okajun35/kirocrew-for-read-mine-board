import { useAppApi } from '@kirocrew/app-sdk'
import { Badge, Btn, Card, CardTitle, ErrorNotice, Input } from '@kirocrew/app-sdk/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useStrings } from './strings'
import type { Meta, SettingsView } from './types'
import { API, errCode, errMessage } from './util'

type TestResult = { ok: boolean; user: { name: string; login: string }; capabilities: { anySearchable: boolean } }

export default function SettingsTab({ settings, meta }: { settings: SettingsView | undefined; meta: Meta | undefined }) {
  const api = useAppApi()
  const qc = useQueryClient()
  const S = useStrings()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [columns, setColumns] = useState<number[]>([])

  useEffect(() => {
    if (settings) {
      setUrl(settings.baseUrl)
      setColumns(settings.kanbanStatusIds)
    }
  }, [settings?.baseUrl, settings?.kanbanStatusIds.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) =>
    setNotice({ ok: false, text: errCode(e) === 'owner_only' ? S.ownerOnly : errMessage(e, S.errorGeneric) })

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<SettingsView>(`${API}/settings`, body),
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data)
      qc.invalidateQueries()
      setKey('')
      setNotice({ ok: true, text: S.settingsSaved })
    },
    onError: fail,
  })

  const test = useMutation({
    mutationFn: () =>
      api.post<TestResult>(`${API}/settings/test`, {
        baseUrl: url.trim() || undefined,
        apiKey: key.trim() || undefined,
      }),
    onSuccess: (r) => setNotice({ ok: true, text: S.settingsTestOk(r.user.name, r.user.login) }),
    onError: fail,
  })

  const insecure = url.trim().startsWith('http://')
  const toggle = (id: number) =>
    setColumns((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))

  return (
    <div className="flex flex-col gap-4" style={{ maxWidth: 760 }}>
      {notice ? (
        notice.ok ? (
          <p className="text-sm"><Badge variant="ok">✓</Badge> {notice.text}</p>
        ) : (
          <ErrorNotice message={notice.text} onDismiss={() => setNotice(null)} />
        )
      ) : null}

      <Card>
        <CardTitle>{S.settingsConnection}</CardTitle>
        <p className="text-sm text-muted" style={{ marginBottom: 8 }}>{S.settingsConnectionHint}</p>
        <label className="text-sm" htmlFor="rb-url">{S.settingsUrl}</label>
        <Input
          id="rb-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={S.settingsUrlPlaceholder}
          autoComplete="off"
          style={{ width: '100%', marginBottom: 8 }}
        />
        {insecure ? <p className="text-sm" style={{ color: 'var(--warn, inherit)', marginBottom: 8 }}>⚠ {S.settingsInsecure}</p> : null}
        <label className="text-sm" htmlFor="rb-key">{S.settingsKey}</label>
        <Input
          id="rb-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={settings?.apiKeySet ? S.settingsKeySet : S.settingsKeyPlaceholder}
          autoComplete="new-password"
          style={{ width: '100%', marginBottom: 10 }}
        />
        <div className="flex gap-2">
          <Btn
            primary
            disabled={save.isPending || !url.trim()}
            onClick={() => save.mutate({ baseUrl: url.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) })}
          >
            {S.settingsSave}
          </Btn>
          <Btn disabled={test.isPending || !url.trim()} onClick={() => test.mutate()}>
            {S.settingsTest}
          </Btn>
        </div>
      </Card>

      {meta ? (
        <Card>
          <CardTitle>{S.settingsKanban}</CardTitle>
          <p className="text-sm text-muted" style={{ marginBottom: 8 }}>{S.settingsKanbanHint}</p>
          <div className="flex gap-2" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
            {meta.statuses.map((s) => (
              <label key={s.id} className="text-sm flex items-center gap-2" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={columns.includes(s.id)} onChange={() => toggle(s.id)} />
                {s.name}
                {columns.includes(s.id) ? <span className="text-muted">({columns.indexOf(s.id) + 1})</span> : null}
              </label>
            ))}
          </div>
          <Btn disabled={save.isPending} onClick={() => save.mutate({ kanbanStatusIds: columns })}>
            {S.settingsKanbanSave}
          </Btn>
        </Card>
      ) : null}
    </div>
  )
}
