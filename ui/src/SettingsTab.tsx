import { useAppApi } from '@kirocrew/app-sdk'
import { Badge, Btn, Card, CardTitle, ErrorNotice, Input } from '@kirocrew/app-sdk/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useStrings } from './strings'
import type { Meta, SettingsView } from './types'
import { API, STAGE_KEYS, errCode, errMessage, stageOfStatuses } from './util'

type TestResult = { ok: boolean; user: { name: string; login: string }; capabilities: { anySearchable: boolean } }

export default function SettingsTab({ settings, meta }: { settings: SettingsView | undefined; meta: Meta | undefined }) {
  const api = useAppApi()
  const qc = useQueryClient()
  const S = useStrings()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [stages, setStages] = useState<Record<string, string>>({})

  useEffect(() => {
    if (settings) {
      setUrl(settings.baseUrl)
      setStages(settings.kanbanStages ?? {})
    }
  }, [settings?.baseUrl, JSON.stringify(settings?.kanbanStages ?? {})]) // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) =>
    setNotice({ ok: false, text: errCode(e) === 'owner_only' ? S.ownerOnly : errMessage(e, S.errorFor, S.errorGeneric) })

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
  const effective = stageOfStatuses(meta?.statuses ?? [], stages)
  const stageLabel: Record<string, string> = {
    todo: S.stageTodo, doing: S.stageDoing, review: S.stageReview, done: S.stageDone,
  }
  const setStage = (id: number, v: string) =>
    setStages((m) => {
      const n = { ...m }
      if (v) n[String(id)] = v
      else delete n[String(id)]
      return n
    })

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
          <CardTitle>{S.settingsStages}</CardTitle>
          <p className="text-sm text-muted" style={{ marginBottom: 8 }}>{S.settingsStagesHint}</p>
          <table style={{ fontSize: 13, borderCollapse: 'collapse', marginBottom: 10 }}>
            <tbody>
              {meta.statuses.map((st) => (
                <tr key={st.id}>
                  <td style={{ padding: '3px 12px 3px 0' }}>{st.isClosed ? `✓ ${st.name}` : st.name}</td>
                  <td style={{ padding: 3 }}>
                    <select
                      aria-label={st.name}
                      value={stages[String(st.id)] ?? ''}
                      onChange={(e) => setStage(st.id, e.target.value)}
                      style={{ fontSize: 13, padding: '2px 6px' }}
                    >
                      <option value="">{`${S.settingsStagesDefault} ${stageLabel[effective.get(st.id) ?? 'doing']}`}</option>
                      {STAGE_KEYS.map((k) => <option key={k} value={k}>{stageLabel[k]}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Btn disabled={save.isPending} onClick={() => save.mutate({ kanbanStages: stages })}>
            {S.settingsStagesSave}
          </Btn>
        </Card>
      ) : null}
    </div>
  )
}
