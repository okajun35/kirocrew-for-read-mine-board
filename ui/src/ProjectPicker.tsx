// Project picker: a button showing the selected project's path, opening a
// popover with a search box, recent projects and a collapsible tree of the
// user's own projects. Projects the user is not in only appear when searching.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStrings } from './strings'
import type { Meta } from './types'
import { box } from './util'

type Project = Meta['projects'][number]

const RECENT_KEY = 'redmine-board:recent-projects'
const MAX_RECENT = 5
const MAX_SEARCH = 50

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function pushRecent(ident: string) {
  try {
    const next = [ident, ...loadRecent().filter((x) => x !== ident)].slice(0, MAX_RECENT)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

/** Child name without the "_"-separated parts it shares with its parent. */
function shortName(name: string, parentName: string | undefined): string {
  if (!parentName) return name
  const shared = new Set(parentName.split('_'))
  const kept = name.split('_').filter((p) => !shared.has(p)).join('_')
  return kept || name
}

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'all' }
  | {
      kind: 'project'
      p: Project
      depth: number
      label: string
      path?: string
      hasChildren: boolean
      collapsed: boolean
      member: boolean
    }

export default function ProjectPicker({
  projects,
  myIds,
  value,
  onChange,
  includeSubprojects,
  onIncludeSubprojects,
}: {
  projects: Project[]
  myIds: Set<number>
  value: string | null
  onChange: (ident: string | null) => void
  includeSubprojects: boolean
  onIncludeSubprojects: (v: boolean) => void
}) {
  const S = useStrings()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const tree = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    const children = new Map<number | null, Project[]>()
    for (const p of projects) {
      const parent = p.parentId != null && byId.has(p.parentId) ? p.parentId : null
      children.set(parent, [...(children.get(parent) ?? []), p])
    }
    const parentOf = (p: Project) => (p.parentId != null ? byId.get(p.parentId) : undefined)
    const label = (p: Project) => shortName(p.name, parentOf(p)?.name)
    const pathOf = (p: Project) => {
      const parts: string[] = []
      for (let cur: Project | undefined = p; cur; cur = parentOf(cur)) parts.unshift(label(cur))
      return parts.join(' › ')
    }
    // the user's projects plus their ancestors, so the hierarchy stays visible
    const visible = new Set<number>()
    for (const id of myIds) {
      for (let cur = byId.get(id); cur && !visible.has(cur.id); cur = parentOf(cur)) visible.add(cur.id)
    }
    return { byId, children, label, pathOf, visible }
  }, [projects, myIds])

  const selected = value ? projects.find((p) => p.identifier === value || String(p.id) === value) : undefined

  const rows = useMemo((): Row[] => {
    const out: Row[] = [{ kind: 'all' }]
    const needle = q.trim().toLowerCase()
    if (needle) {
      const hits = projects
        .filter((p) => p.name.toLowerCase().includes(needle) || p.identifier.toLowerCase().includes(needle))
        .sort((a, b) => Number(!myIds.has(a.id)) - Number(!myIds.has(b.id)))
        .slice(0, MAX_SEARCH)
      if (!hits.length) out.push({ kind: 'header', label: S.projectNoMatch })
      for (const p of hits) {
        out.push({
          kind: 'project', p, depth: 0, label: tree.label(p), path: tree.pathOf(p),
          hasChildren: false, collapsed: false, member: myIds.has(p.id),
        })
      }
      return out
    }
    const recent = loadRecent()
      .map((ident) => projects.find((p) => p.identifier === ident))
      .filter((p): p is Project => !!p)
    if (recent.length) {
      out.push({ kind: 'header', label: S.projectRecent })
      for (const p of recent) {
        out.push({
          kind: 'project', p, depth: 0, label: tree.pathOf(p),
          hasChildren: false, collapsed: false, member: myIds.has(p.id),
        })
      }
    }
    if (tree.visible.size) {
      out.push({ kind: 'header', label: S.projectMine })
      const walk = (parent: number | null, depth: number) => {
        for (const p of tree.children.get(parent) ?? []) {
          if (!tree.visible.has(p.id)) continue
          const kids = (tree.children.get(p.id) ?? []).filter((c) => tree.visible.has(c.id))
          const isCollapsed = collapsed.has(p.id)
          out.push({
            kind: 'project', p, depth, label: tree.label(p),
            hasChildren: kids.length > 0, collapsed: isCollapsed, member: myIds.has(p.id),
          })
          if (!isCollapsed) walk(p.id, depth + 1)
        }
      }
      walk(null, 0)
    }
    out.push({ kind: 'header', label: S.projectSearchHint })
    return out
  }, [q, projects, myIds, tree, collapsed, S, open]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectable = rows.map((r, i) => (r.kind === 'header' ? -1 : i)).filter((i) => i >= 0)

  useEffect(() => {
    if (!open) return
    setQ('')
    setHi(0)
    setTimeout(() => searchRef.current?.focus(), 0)
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${selectable[hi]}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [hi]) // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (r: Row | undefined) => {
    if (!r || r.kind === 'header') return
    if (r.kind === 'all') onChange(null)
    else {
      pushRecent(r.p.identifier)
      onChange(r.p.identifier)
    }
    setOpen(false)
  }
  const toggle = (id: number, to?: boolean) =>
    setCollapsed((s) => {
      const n = new Set(s)
      const shouldCollapse = to ?? !n.has(id)
      if (shouldCollapse) n.add(id)
      else n.delete(id)
      return n
    })

  const onKey = (e: React.KeyboardEvent) => {
    const r = rows[selectable[hi]]
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((h) => Math.min(selectable.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((h) => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(r)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !q && r?.kind === 'project' && r.hasChildren) {
      e.preventDefault()
      toggle(r.p.id, e.key === 'ArrowLeft')
    }
  }

  const buttonLabel = selected ? tree.pathOf(selected) : S.projectAll

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={S.projectFilter}
        title={selected?.name ?? S.projectAll}
        onClick={() => setOpen((o) => !o)}
        style={{
          ...box.card,
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', fontSize: 13, cursor: 'pointer', maxWidth: 360,
          color: 'var(--text, inherit)',
        }}
      >
        <span aria-hidden>📁</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{buttonLabel}</span>
        {selected && !includeSubprojects ? (
          <span style={{ ...box.muted, fontSize: 11, whiteSpace: 'nowrap' }}>{S.projectOnlyThis}</span>
        ) : null}
        <span aria-hidden style={box.muted}>▾</span>
      </button>

      {open ? (
        <div
          onKeyDown={onKey}
          style={{
            ...box.card,
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30,
            width: 380, maxWidth: '90vw', boxShadow: '0 8px 24px rgba(0,0,0,.18)',
            display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setHi(0)
              }}
              placeholder={S.projectSearch}
              aria-label={S.projectSearch}
              style={{
                width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--bg, transparent)', color: 'inherit',
              }}
            />
          </div>
          <ul ref={listRef} role="listbox" style={{ listStyle: 'none', margin: 0, padding: 4, maxHeight: 360, overflowY: 'auto' }}>
            {rows.map((r, i) => {
              if (r.kind === 'header') {
                return (
                  <li key={`h${i}`} style={{ ...box.muted, fontSize: 11, padding: '8px 8px 4px' }}>{r.label}</li>
                )
              }
              const active = selectable[hi] === i
              const isSel = r.kind === 'all' ? !selected : selected?.id === r.p.id
              return (
                <li
                  key={r.kind === 'all' ? 'all' : `${i}-${r.p.id}`}
                  data-row={i}
                  role="option"
                  aria-selected={isSel}
                  title={r.kind === 'project' ? r.p.name : undefined}
                  onMouseEnter={() => setHi(selectable.indexOf(i))}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(r)
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '5px 8px', borderRadius: 4, fontSize: 13, cursor: 'pointer',
                    paddingLeft: 8 + (r.kind === 'project' ? r.depth * 16 : 0),
                    background: active ? 'var(--bg-hover)' : undefined,
                  }}
                >
                  {r.kind === 'project' && r.hasChildren ? (
                    <span
                      role="button"
                      aria-label={r.collapsed ? S.projectExpand : S.projectCollapse}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        toggle(r.p.id)
                      }}
                      style={{ width: 14, textAlign: 'center', ...box.muted }}
                    >
                      {r.collapsed ? '▸' : '▾'}
                    </span>
                  ) : (
                    <span style={{ width: 14 }} />
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        ...(r.kind === 'project' && !r.member ? box.muted : {}),
                      }}
                    >
                      {r.kind === 'all' ? S.projectAll : r.label}
                    </span>
                    {r.kind === 'project' && r.path && r.path !== r.label ? (
                      <span style={{ display: 'block', ...box.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.path}
                      </span>
                    ) : null}
                  </span>
                  {isSel ? <span aria-hidden>✓</span> : null}
                </li>
              )
            })}
          </ul>
          <label
            className="text-sm"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px',
              borderTop: '1px solid var(--border)', ...(selected ? {} : box.muted),
            }}
          >
            <input
              type="checkbox"
              disabled={!selected}
              checked={includeSubprojects}
              onChange={(e) => onIncludeSubprojects(e.target.checked)}
            />
            {S.includeSubprojects}
          </label>
        </div>
      ) : null}
    </div>
  )
}
