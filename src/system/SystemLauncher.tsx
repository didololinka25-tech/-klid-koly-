import type { ModuleAccess } from './access'
import type { Profile } from '../schoolRepository'

export function SystemLauncher({
  profile,
  access,
  onOpenCleaning,
  onOpenCafeteria,
  onSignOut,
}: {
  profile: Profile
  access: ModuleAccess
  onOpenCleaning: () => void
  onOpenCafeteria: () => void
  onSignOut: () => Promise<void>
}) {
  const hasAccess = access.cleaning || access.cafeteria
  return (
    <main className="app system-app">
      <header className="system-header">
        <div><p className="eyebrow">ŠKOLNÍ SYSTÉM</p><h1>Kam chcete pokračovat?</h1></div>
        <button className="system-signout" type="button" onClick={() => void onSignOut()}>Odhlásit</button>
      </header>
      <p className="system-welcome">{profile.full_name}</p>
      <section className="module-list" aria-label="Dostupné moduly">
        {access.cafeteria && (
          <button className="module-card" type="button" onClick={onOpenCafeteria}>
            <span aria-hidden="true">🍽️</span><span><b>Jídelna</b><small>Obědy, jídelníček a platby</small></span><i aria-hidden="true">›</i>
          </button>
        )}
        {access.cleaning && (
          <button className="module-card" type="button" onClick={onOpenCleaning}>
            <span aria-hidden="true">🧹</span><span><b>Úklid</b><small>Úklid školy a školky</small></span><i aria-hidden="true">›</i>
          </button>
        )}
      </section>
      {!hasAccess && (
        <section className="panel system-empty">
          <span aria-hidden="true">⏳</span>
          <h2>Účet čeká na oprávnění</h2>
          <p>Účet je vytvořen a čeká na přidělení oprávnění.</p>
        </section>
      )}
      {!access.cafeteriaAvailable && access.cleaning && (
        <p className="system-note">Jídelna zatím není aktivována.</p>
      )}
    </main>
  )
}
