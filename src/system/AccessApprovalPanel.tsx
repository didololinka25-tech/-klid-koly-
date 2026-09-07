import { useCallback, useEffect, useState } from 'react'
import {
  accessApprovalRepository,
  approvalErrorMessage,
  type ApprovalAssignment,
  type ApprovalFamily,
  type PendingAccessUser,
} from './accessApprovalRepository'

type DraftAssignment = ApprovalAssignment & { id: string }

const newAssignment = (): DraftAssignment => ({
  id: crypto.randomUUID(),
  module: 'cafeteria',
  role: 'parent',
  familyId: null,
})

const roleOptions = {
  cafeteria: [
    ['parent', 'Rodič'],
    ['diner', 'Strávník'],
    ['kitchen', 'Kuchyň'],
    ['admin', 'Správa Jídelny'],
  ],
  cleaning: [
    ['cleaning_team', 'Úklidový tým'],
    ['visitor', 'Návštěvník'],
    ['admin', 'Správa Úklidu'],
  ],
} as const

export function AccessApprovalPanel({ onApproved }: { onApproved: () => Promise<void> }) {
  const [users, setUsers] = useState<PendingAccessUser[]>([])
  const [families, setFamilies] = useState<ApprovalFamily[]>([])
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<PendingAccessUser | null>(null)
  const [assignments, setAssignments] = useState<DraftAssignment[]>([newAssignment()])
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await accessApprovalRepository.load()
      setAvailable(data.available)
      setUsers(data.users)
      setFamilies(data.families)
    } catch (error) {
      console.error('Čekající přístupy se nepodařilo načíst:', error)
      setNotice('Čekající uživatele se nepodařilo načíst.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const startApproval = (user: PendingAccessUser) => {
    setEditing(user)
    setAssignments([newAssignment()])
    setNotice('')
  }
  const updateAssignment = (id: string, values: Partial<DraftAssignment>) => {
    setAssignments((current) => current.map((item) => item.id === id ? { ...item, ...values } : item))
  }

  if (!available) return <section className="panel approval-panel"><h2>Čekají na schválení</h2><p className="hint">Bezpečné schvalování bude dostupné po aplikaci připravené databázové migrace.</p></section>

  return (
    <section className="approval-panel">
      <div className="section-heading">
        <span><p className="eyebrow">NOVÉ ÚČTY</p><h2>Čekají na schválení</h2></span>
        {users.length > 0 && <strong className="approval-count">{users.length}</strong>}
      </div>
      {loading && <p className="hint">Načítám čekající účty…</p>}
      {!loading && users.length === 0 && <section className="panel approval-empty"><span aria-hidden="true">✓</span><p>Nikdo nečeká na schválení.</p></section>}
      <div className="approval-user-list">
        {users.map((user) => (
          <article className="panel approval-user" key={user.id}>
            <div><b>{user.fullName}</b><small>{user.email || 'E-mail není dostupný'}</small><small>První přihlášení: {formatDate(user.firstSignedInAt)}</small></div>
            <button type="button" onClick={() => startApproval(user)}>Schválit</button>
          </article>
        ))}
      </div>
      {editing && (
        <div className="approval-dialog-backdrop" role="presentation">
          <form className="panel approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-dialog-title" onSubmit={async (event) => {
            event.preventDefault()
            setSaving(true)
            setNotice('')
            try {
              await accessApprovalRepository.approve(editing.id, assignments)
              await load()
              await onApproved()
              setEditing(null)
              setNotice(`${editing.fullName}: přístup byl schválen.`)
            } catch (error) {
              setNotice(approvalErrorMessage(error))
            } finally {
              setSaving(false)
            }
          }}>
            <header><div><p className="eyebrow">SCHVÁLENÍ PŘÍSTUPU</p><h2 id="approval-dialog-title">{editing.fullName}</h2></div><button type="button" className="approval-close" onClick={() => setEditing(null)} aria-label="Zavřít schválení">×</button></header>
            <p className="hint">Vyberte všechny moduly a role, které má člověk po schválení získat.</p>
            <div className="approval-assignments">
              {assignments.map((assignment, index) => (
                <fieldset key={assignment.id}>
                  <legend>Oprávnění {index + 1}</legend>
                  <label>Modul<select value={assignment.module} onChange={(event) => {
                    const module = event.target.value as DraftAssignment['module']
                    updateAssignment(assignment.id, { module, role: module === 'cafeteria' ? 'parent' : 'cleaning_team', familyId: null })
                  }}><option value="cafeteria">Jídelna</option><option value="cleaning">Úklid</option></select></label>
                  <label>Role<select value={assignment.role} onChange={(event) => updateAssignment(assignment.id, { role: event.target.value, familyId: null })}>{roleOptions[assignment.module].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                  {assignment.module === 'cafeteria' && assignment.role === 'parent' && <label>Rodina (volitelné)<select value={assignment.familyId ?? ''} onChange={(event) => updateAssignment(assignment.id, { familyId: event.target.value || null })}><option value="">Bez přiřazení rodiny</option>{families.map((family) => <option value={family.id} key={family.id}>{family.displayName}</option>)}</select></label>}
                  {assignments.length > 1 && <button type="button" className="approval-remove" onClick={() => setAssignments((current) => current.filter((item) => item.id !== assignment.id))}>Odebrat řádek</button>}
                </fieldset>
              ))}
            </div>
            {assignments.length < 10 && <button type="button" className="approval-add" onClick={() => setAssignments((current) => [...current, newAssignment()])}>+ Přidat další roli</button>}
            {notice && <p className="notice" role="alert">{notice}</p>}
            <div className="editor-actions"><button type="button" onClick={() => setEditing(null)}>Zrušit</button><button type="submit" disabled={saving}>{saving ? 'Schvaluji…' : 'Potvrdit schválení'}</button></div>
          </form>
        </div>
      )}
      {!editing && notice && <p className="notice" role="status">{notice}</p>}
    </section>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
