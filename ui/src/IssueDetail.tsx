import { useAppApi, useChatLauncher } from '@kirocrew/app-sdk'
import { Badge, Btn, ErrorNotice, MarkdownRenderer } from '@kirocrew/app-sdk/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Strings } from './strings'
import { useStrings } from './strings'
import type { IssueDetail as Issue } from './types'
import { AGENT, API, box, errMessage, fmtDay, fmtWhen, priorityTone, qs, safeHref } from './util'

type Ask = 'investigate' | 'plan' | 'fix'

export function handoffMessage(S: Strings, kind: Ask, it: Issue): string {
  // Subject is user-written text: it goes in a quoted data line, never as an instruction.
  return [
    S.promptIntro[kind],
    '',
    `- ${S.promptIssue}: #${it.id} (${it.url})`,
    `- ${S.promptProject}: ${it.project?.name ?? '—'}`,
    `- ${S.promptSubject}: "${it.subject.replace(/[\r\n]+/g, ' ').slice(0, 200)}"`,
    '',
    S.promptRules,
  ].join('\n')
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm text-muted" style={{ fontSize: 12 }}>{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  )
}

function Body({ text, onOpenIssue }: { text: string; onOpenIssue: (id: number) => void }) {
  // #123 -> in-app issue link (fragment href, intercepted below)
  const linked = text
    .replace(/\r\n/g, '\n')
    .replace(/(^|\W)#(\d{1,9})\b/g, (_m, pre, id) => `${pre}[#${id}](#issue-${id})`)
  return (
    <div
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        const m = a?.getAttribute('href')?.match(/^#issue-(\d+)$/)
        if (m) {
          e.preventDefault()
          onOpenIssue(Number(m[1]))
        }
      }}
    >
      <MarkdownRenderer content={linked} />
    </div>
  )
}

function CommentBox({ id, userName }: { id: number; userName: string | undefined }) {
  const api = useAppApi()
  const qc = useQueryClient()
  const S = useStrings()
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const post = useMutation({
    mutationFn: () => api.post(`${API}/issue/comment`, { id, body }),
    onSuccess: () => {
      setBody('')
      setPreview(false)
      setErr(null)
      qc.invalidateQueries({ queryKey: ['issue', id] })
    },
    onError: (e) => setErr(errMessage(e, S.errorFor, S.errorGeneric)),
  })
  return (
    <section style={{ ...box.card, padding: 10 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
        <strong className="text-sm">{S.commentTitle}</strong>
        {userName ? <span className="text-sm text-muted" style={{ fontSize: 12 }}>{S.commentAs(userName)}</span> : null}
        <Btn onClick={() => setPreview((p) => !p)} style={{ marginLeft: 'auto', fontSize: 12 }}>
          {preview ? S.commentEdit : S.commentPreview}
        </Btn>
      </div>
      {preview ? (
        <div style={{ minHeight: 60 }}>
          {body.trim() ? <MarkdownRenderer content={body} /> : <p className="text-sm text-muted">{S.commentEmpty}</p>}
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={S.commentPlaceholder}
          rows={3}
          style={{ width: '100%', fontSize: 13, resize: 'vertical' }}
        />
      )}
      {err ? <p className="text-sm" style={{ color: 'var(--err, #d33)' }}>{err}</p> : null}
      <div style={{ marginTop: 6, textAlign: 'right' }}>
        <Btn primary disabled={!body.trim() || post.isPending} onClick={() => post.mutate()}>
          {post.isPending ? S.commentPosting : S.commentPost}
        </Btn>
      </div>
    </section>
  )
}

export default function IssueDetail({
  id,
  onClose,
  onOpenIssue,
  user,
}: {
  id: number
  onClose: () => void
  onOpenIssue: (id: number) => void
  user?: { id: number; login: string; name: string; admin: boolean }
}) {
  const api = useAppApi()
  const S = useStrings()
  const { openChat } = useChatLauncher()
  const q = useQuery({
    queryKey: ['issue', id],
    queryFn: ({ signal }) => api.get<Issue>(`${API}/issue${qs({ id })}`, { signal }),
  })
  const it = q.data

  const ask = (kind: Ask) => it && openChat({ agent: AGENT, message: handoffMessage(S, kind, it), autoSend: false })

  return (
    <aside
      aria-label={it ? `#${it.id}` : String(id)}
      style={{
        ...box.card,
        width: 460,
        flex: '0 0 460px',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'calc(100vh - 200px)',
        position: 'sticky',
        top: 0,
      }}
    >
      <header className="flex items-center gap-2" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <strong>#{id}</strong>
        {it ? (
          <Badge variant={it.status.isClosed ? 'muted' : 'aim'}>
            {it.status.isClosed ? `✓ ${it.status.name}` : it.status.name}
          </Badge>
        ) : null}
        <span style={{ marginLeft: 'auto' }} className="flex gap-2">
          {it && safeHref(it.url) ? (
            <a href={safeHref(it.url)} target="_blank" rel="noopener noreferrer" className="text-sm">
              {S.detailOpenRedmine} ↗
            </a>
          ) : null}
          <Btn onClick={onClose} aria-label={S.detailClose}>✕</Btn>
        </span>
      </header>

      <div style={{ overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {q.error ? <ErrorNotice message={errMessage(q.error, S.errorFor, S.errorGeneric)} /> : null}
        {!it && !q.error ? <p className="text-sm text-muted">{S.loading}</p> : null}
        {it ? (
          <>
            <h2 style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4, margin: 0 }}>
              {it.tracker ? <span style={box.muted}>[{it.tracker.name}] </span> : null}
              {it.subject}
            </h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Field label={S.colProject}>{it.project?.name ?? '—'}</Field>
              <Field label={S.colPriority}>
                <Badge variant={priorityTone(it.priority?.name)}>{it.priority?.name ?? '—'}</Badge>
              </Field>
              <Field label={S.colAssignee}>{it.assignedTo?.name ?? S.unassigned}</Field>
              <Field label={S.detailAuthor}>{it.author?.name ?? '—'}</Field>
              <Field label={S.detailCreated}>{fmtWhen(it.createdOn)}</Field>
              <Field label={S.detailUpdated}>{fmtWhen(it.updatedOn)}</Field>
              <Field label={S.detailDue}>{fmtDay(it.dueDate)}</Field>
              <Field label={S.detailDone}>{it.doneRatio != null ? `${it.doneRatio}%` : '—'}</Field>
            </div>

            <section style={{ ...box.card, padding: 10 }}>
              <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
                <strong className="text-sm">🤖 {S.askKiro}</strong>
              </div>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <Btn primary onClick={() => ask('investigate')}>{S.askInvestigate}</Btn>
                <Btn onClick={() => ask('plan')}>{S.askPlan}</Btn>
                <Btn onClick={() => ask('fix')}>{S.askFix}</Btn>
              </div>
              <p className="text-sm text-muted" style={{ fontSize: 12, marginTop: 6 }}>{S.askHint}</p>
            </section>

            <section>
              <h3 className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>{S.detailDescription}</h3>
              {it.description.trim() ? <Body text={it.description} onOpenIssue={onOpenIssue} /> : <p className="text-sm text-muted">{S.detailNoDescription}</p>}
            </section>

            {it.children.length ? (
              <section>
                <h3 className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>{S.detailChildren}</h3>
                <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
                  {it.children.map((c) => (
                    <li key={c.id}>#{c.id} {c.subject}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {it.relations.length ? (
              <section>
                <h3 className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>{S.detailRelations}</h3>
                <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
                  {it.relations.map((r) => (
                    <li key={r.id}>{r.type} #{r.issueId === it.id ? r.issueToId : r.issueId}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {it.attachments.length ? (
              <section>
                <h3 className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>{S.detailAttachments}</h3>
                <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
                  {it.attachments.map((a) => (
                    <li key={a.id}>
                      {safeHref(a.url) ? (
                        <a href={safeHref(a.url)} target="_blank" rel="noopener noreferrer">{a.filename}</a>
                      ) : (
                        a.filename
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section>
              <h3 className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>{S.detailHistory}</h3>
              {!it.journals.some((j) => j.notes || j.details.length) ? (
                <p className="text-sm text-muted">{S.detailNoHistory}</p>
              ) : (
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {it.journals
                    .filter((j) => j.notes || j.details.length)
                    .map((j) => (
                      <li key={j.id} style={{ borderLeft: '2px solid var(--border)', paddingLeft: 10 }}>
                        <div className="text-sm text-muted" style={{ fontSize: 12 }}>
                          {j.user?.name ?? '—'} · {fmtWhen(j.createdOn)}
                        </div>
                        {j.details.map((d, i) => (
                          <div key={i} className="text-sm text-muted" style={{ fontSize: 12 }}>
                            {S.changed(d.name, d.oldValue, d.newValue)}
                          </div>
                        ))}
                        {j.notes ? <Body text={j.notes} onOpenIssue={onOpenIssue} /> : null}
                      </li>
                    ))}
                </ol>
              )}
            </section>

            <CommentBox id={it.id} userName={user?.name} />
          </>
        ) : null}
      </div>
    </aside>
  )
}
