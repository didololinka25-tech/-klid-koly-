import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import CleaningApp from '../App'
import { CafeteriaApp } from '../cafeteria/CafeteriaApp'
import { isSupabaseConfigured } from '../supabase'
import { resolveModuleAccess, routeAllowed, routeFromHash, routeHash, type SystemRoute } from './access'
import { systemRepository, type SystemIdentity } from './systemRepository'
import { SystemLauncher } from './SystemLauncher'

export default function SystemApp() {
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [identity, setIdentity] = useState<SystemIdentity | null>(null)
  const [route, setRoute] = useState<SystemRoute>(() => routeFromHash(window.location.hash))
  const [notice, setNotice] = useState('')

  const loadIdentity = useCallback(async (next: Session | null) => {
    setSession(next)
    if (!next) {
      setIdentity(null)
      setReady(true)
      return
    }
    try {
      setIdentity(await systemRepository.identity(next))
    } catch (error) {
      console.error('Společnou identitu se nepodařilo načíst:', error)
      setIdentity(null)
      setNotice('Profil se zatím nepodařilo načíst.')
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured) return
    void systemRepository.getSession().then(loadIdentity)
    const { data } = systemRepository.onAuthChange((next) => void loadIdentity(next))
    return () => data.subscription.unsubscribe()
  }, [loadIdentity])

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const access = useMemo(() => identity ? resolveModuleAccess({
    profileActive: identity.profile.active,
    cleaningAccessRole: identity.cleaningAccessRole,
    moduleRoles: identity.moduleRoles,
    cafeteriaAvailable: identity.cafeteriaAvailable,
  }) : null, [identity])

  const navigate = (next: SystemRoute) => {
    const hash = routeHash(next)
    if (window.location.hash === hash) setRoute(next)
    else window.location.hash = hash
  }

  useEffect(() => {
    if (access && !routeAllowed(route, access)) navigate('launcher')
  }, [access, route])

  if (!isSupabaseConfigured) return <SystemSetupScreen />
  if (!ready) return <SystemLoadingScreen />
  if (!session || !identity) return <SystemLoginScreen notice={notice} onLogin={async () => {
    setNotice('')
    try { await systemRepository.signInWithGoogle() }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Přihlášení přes Google se nezdařilo.') }
  }} />
  if (!identity.profile.active) return <SystemAccessScreen title="Účet je deaktivovaný" onSignOut={systemRepository.signOut} />
  if (!access || !routeAllowed(route, access)) return <SystemLoadingScreen />
  if (route === 'cleaning') return <CleaningApp onOpenLauncher={() => navigate('launcher')} />
  if (route === 'cafeteria') return <CafeteriaApp profile={identity.profile} roles={access.cafeteriaRoles} onOpenLauncher={() => navigate('launcher')} onSignOut={systemRepository.signOut} />
  return <SystemLauncher profile={identity.profile} access={access} onOpenCleaning={() => navigate('cleaning')} onOpenCafeteria={() => navigate('cafeteria')} onSignOut={systemRepository.signOut} />
}

function SystemLoadingScreen() {
  return <main className="app"><section className="panel login"><span className="loading-spinner" /><p>Načítám školní systém…</p></section></main>
}

function SystemAccessScreen({ title, onSignOut }: { title: string; onSignOut: () => Promise<void> }) {
  return <main className="app"><section className="panel login access-state"><p className="eyebrow">ŠKOLNÍ SYSTÉM</p><h1>{title}</h1><p>Obraťte se na hlavního správce systému.</p><button onClick={() => void onSignOut()}>Odhlásit se</button></section></main>
}

function SystemSetupScreen() {
  return <main className="app"><section className="empty"><span>⚙</span><h1>Dokončete propojení</h1><p>Do <code>.env.local</code> vložte veřejnou adresu Supabase a veřejný anon klíč.</p></section></main>
}

function SystemLoginScreen({ notice, onLogin }: { notice: string; onLogin: () => Promise<void> }) {
  return <main className="app"><section className="panel login"><p className="eyebrow">ŠKOLNÍ SYSTÉM</p><h1>Přihlášení</h1><p className="hint">Jedním školním Google účtem se přihlásíte ke všem dostupným modulům.</p>{notice && <div className="notice">{notice}</div>}<button onClick={() => void onLogin()}>Pokračovat přes Google</button></section></main>
}
