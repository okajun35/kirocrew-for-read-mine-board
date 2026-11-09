import { Btn, Input } from '@kirocrew/app-sdk/ui'
import { useMemo, useRef, useState } from 'react'
import { useStrings } from './strings'
import type { Chip, Meta, ProjectOptions, QueryError, SavedView } from './types'
import { addToken, box, qv } from './util'

/** Value candidates per canonical field key. */
function valueMap(meta: Meta | undefined, opts: ProjectOptions | undefined): Record<string, string[]> {
  const mine = new Set(meta?.myProjectIds ?? [])
  const m: Record<string, string[]> = {
    status: ['open', 'closed', '*', ...(meta?.statuses ?? []).map((s) => s.name)],
    tracker: (meta?.trackers ?? []).map((t) => t.name),
    priority: (meta?.priorities ?? []).map((p) => p.name),
    // the user's own projects first
    project: [...(meta?.projects ?? [])]
      .sort((a, b) => Number(!mine.has(a.id)) - Number(!mine.has(b.id)))
      .map((p) => p.identifier),
    assignee: ['me', 'none', ...(opts?.members ?? []).map((x) => x.name)],
    author: ['me', 'none', ...(opts?.members ?? []).map((x) => x.name)],
    version: (opts?.versions ?? []).map((v) => v.name),
    category: (opts?.categories ?? []).map((c) => c.name),
    parent: ['none'],
  }
  for (const f of meta?.fields ?? []) {
    if (f.kind === 'date') {
      m[f.key] = ['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month', '<7d', '>30d']
      if (f.key === 'due') m[f.key].unshift('overdue')
    }
  }
  return m
}

export default function SearchBar({
  draft,
  setDraft,
  onSubmit,
  meta,
  options,
  chips,
  errors,
  onEditChip,
  onRemoveChip,
  views,
  onApplyView,
  onSaveView,
  onDeleteView,
  inputRef,
}: {
  draft: string
  setDraft: (v: string) => void
  onSubmit: () => void
  meta: Meta | undefined
  options: ProjectOptions | undefined
  chips: Chip[]
  errors: QueryError[]
  onEditChip: (raw: string) => void
  onRemoveChip: (raw: string) => void
  views: SavedView[]
  onApplyView: (v: SavedView | null) => void
  onSaveView: (name: string) => void
  onDeleteView: (name: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const S = useStrings()
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const [saving, setSaving] = useState(false)
  const [viewName, setViewName] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const aliasToKey = useMemo(() => {
    const m: Record<string, string> = {}
    for (const f of meta?.fields ?? []) {
      m[f.key] = f.key
      for (const a of f.aliases) m[a] = f.key
    }
    return m
  }, [meta])
  const vals = useMemo(() => valueMap(meta, options), [meta, options])

  // current (incomplete) token = text after the last unquoted space
  const tail = useMemo(() => {
    let inQ = false
    let start = 0
    for (let i = 0; i < draft.length; i++) {
      const ch = draft[i]
      if (ch === '"') inQ = !inQ
      else if (/\s/.test(ch) && !inQ) start = i + 1
    }
    return draft.slice(start)
  }, [draft])

  const suggestions = useMemo((): { label: string; insert: string }[] => {
    const t = tail.replace(/^-/, '')
    const ci = t.indexOf(':')
    if (ci >= 0) {
      const key = aliasToKey[t.slice(0, ci).toLowerCase()]
      const part = t.slice(ci + 1).split(',').pop()?.replace(/^["']/, '').toLowerCase() ?? ''
      const list = key ? vals[key] ?? [] : []
      return list
        .filter((v) => v.toLowerCase().includes(part))
        .slice(0, 8)
        .map((v) => ({ label: v, insert: qv(v) }))
    }
    if (/^[a-zA-Zぁ-ゟ゠-ヿ一-鿿.]*$/.test(t) || /^cf\./i.test(t)) {
      const out: { label: string; insert: string }[] = []
      for (const f of meta?.fields ?? []) {
        for (const a of [f.key, ...f.aliases]) {
          if (a.toLowerCase().startsWith(t.toLowerCase()) && t !== a) {
            out.push({ label: `${a}:`, insert: `${a}:` })
          }
        }
      }
      if (t && 'cf.'.startsWith(t.toLowerCase())) out.push({ label: 'cf.', insert: 'cf.' })
      for (const cf of options?.customFields ?? []) {
        if (`cf.${cf.name}`.toLowerCase().startsWith(t.toLowerCase()))
          out.push({ label: `cf.${cf.name}:`, insert: `cf.${cf.name}:` })
      }
      return out.slice(0, 8)
    }
    return []
  }, [tail, meta, options, aliasToKey, vals])

  const accept = (i: number) => {
    const s = suggestions[i]
    if (!s) return
    const neg = tail.startsWith('-')
    const ci = tail.replace(/^-/, '').indexOf(':')
    let newTail: string
    if (ci >= 0) {
      const fieldPart = tail.slice(0, neg ? ci + 2 : ci + 1)
      const afterColon = tail.slice(neg ? ci + 2 : ci + 1)
      const commas = afterColon.split(',')
      commas[commas.length - 1] = s.insert
      newTail = fieldPart + commas.join(',')
    } else {
      newTail = tail.startsWith('-') ? `-${s.insert}` : s.insert
    }
    setDraft(draft.slice(0, draft.length - tail.length) + newTail)
    setHi(0)
    inputRef.current?.focus()
  }

  const errTokens = new Set(errors.map((e) => e.token))
  const chipLabel = (c: Chip) =>
    c.kind === 'text' ? (c.negated ? `¬ ${c.text}` : `“${c.text}”`) : c.raw

  return (
    <div ref={rootRef} style={{ position: 'relative', marginBottom: 8 }}>
      <form
        className="flex items-center gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          setOpen(false)
          onSubmit()
        }}
      >
        <div style={{ position: 'relative', minWidth: 280, flex: '1 1 320px' }}>
          <Input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setOpen(true)
              setHi(0)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && suggestions.length) {
                e.preventDefault()
                setHi((h) => (h + 1) % suggestions.length)
              } else if (e.key === 'ArrowUp' && suggestions.length) {
                e.preventDefault()
                setHi((h) => (h - 1 + suggestions.length) % suggestions.length)
              } else if ((e.key === 'Tab' || e.key === 'Enter') && open && suggestions.length) {
                e.preventDefault()
                accept(hi)
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            placeholder={S.searchPlaceholder}
            aria-label={S.searchPlaceholder}
            aria-expanded={open && suggestions.length > 0}
            role="combobox"
            aria-autocomplete="list"
          />
          {open && suggestions.length ? (
            <ul
              role="listbox"
              style={{
                ...box.card,
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                zIndex: 20,
                margin: '4px 0 0',
                padding: 4,
                listStyle: 'none',
                maxHeight: 240,
                overflowY: 'auto',
              }}
            >
              {suggestions.map((s, i) => (
                <li
                  key={s.label + i}
                  role="option"
                  aria-selected={i === hi}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    accept(i)
                  }}
                  onMouseEnter={() => setHi(i)}
                  style={{
                    padding: '5px 8px',
                    borderRadius: 4,
                    fontSize: 13,
                    cursor: 'pointer',
                    background: i === hi ? 'var(--bg-hover)' : undefined,
                  }}
                >
                  {s.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Btn primary type="submit">{S.searchButton}</Btn>
        <select
          aria-label={S.savedViews}
          value=""
          onChange={(e) => {
            const v = views[Number(e.target.value)]
            if (v) onApplyView(v)
            e.target.value = ''
          }}
          style={{ fontSize: 13, padding: '4px 6px', maxWidth: 160 }}
        >
          <option value="">{S.savedViews}</option>
          {views.map((v, i) => (
            <option key={v.name} value={i}>{v.name}</option>
          ))}
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
          {views.length ? (
            <select
              aria-label={S.viewDelete}
              value=""
              onChange={(e) => {
                if (e.target.value) onDeleteView(e.target.value)
                e.target.value = ''
              }}
              style={{ fontSize: 13, padding: '4px 6px' }}
            >
              <option value="">{S.viewDelete}…</option>
              {views.map((v) => (
                <option key={v.name} value={v.name}>{v.name}</option>
              ))}
            </select>
          ) : null}
        </form>
      ) : null}

      {chips.length || errors.length ? (
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          {chips.map((c, i) => {
            const bad = errTokens.has(c.raw)
            return (
              <span
                key={c.raw + i}
                role="button"
                tabIndex={0}
                title={bad ? S.chipError : S.chipEditHint}
                onClick={() => onEditChip(c.raw)}
                onKeyDown={(e) => e.key === 'Enter' && onEditChip(c.raw)}
                style={{
                  ...box.chip,
                  borderColor: bad ? 'var(--err, #d33)' : 'var(--border)',
                  color: bad ? 'var(--err, #d33)' : undefined,
                }}
              >
                {chipLabel(c)}
                <span
                  role="button"
                  aria-label={S.chipRemove}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveChip(c.raw)
                  }}
                  style={{ opacity: 0.6 }}
                >
                  ✕
                </span>
              </span>
            )
          })}
          {errors.map((e, i) => (
            <span key={'e' + i} className="text-sm" style={{ color: 'var(--err, #d33)', fontSize: 12 }}>
              {S.queryError(e)}
            </span>
          ))}
          <Btn type="button" onClick={() => onApplyView(null)} style={{ fontSize: 12 }}>{S.clearFilters}</Btn>
        </div>
      ) : null}
    </div>
  )
}

export { valueMap }
export const _unused_addToken = addToken
