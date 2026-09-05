export const cafeteriaRoles = ['parent', 'diner', 'kitchen', 'admin'] as const

export type CafeteriaRole = (typeof cafeteriaRoles)[number]
export type SystemRoute = 'launcher' | 'cleaning' | 'cafeteria'

export type ModuleRole = {
  module: 'cafeteria' | 'cleaning'
  role: string
}

export type ModuleAccess = {
  cleaning: boolean
  cafeteria: boolean
  cafeteriaAvailable: boolean
  cafeteriaRoles: CafeteriaRole[]
}

export const isMissingCafeteriaSchema = (error: { code?: string } | null) =>
  Boolean(error && ['42P01', 'PGRST205'].includes(error.code ?? ''))

export function normalizeCafeteriaRoles(rows: ModuleRole[]): CafeteriaRole[] {
  return cafeteriaRoles.filter((role) =>
    rows.some((row) => row.module === 'cafeteria' && row.role === role),
  )
}

export function resolveModuleAccess(input: {
  profileActive: boolean
  cleaningAccessRole: string
  moduleRoles: ModuleRole[]
  cafeteriaAvailable: boolean
}): ModuleAccess {
  const roles = normalizeCafeteriaRoles(input.moduleRoles)
  const active = input.profileActive
  return {
    cleaning: active && ['cleaning_team', 'admin', 'visitor'].includes(input.cleaningAccessRole),
    cafeteria: active && input.cafeteriaAvailable && roles.length > 0,
    cafeteriaAvailable: input.cafeteriaAvailable,
    cafeteriaRoles: active ? roles : [],
  }
}

export function routeFromHash(hash: string): SystemRoute {
  if (hash === '#/cleaning') return 'cleaning'
  if (hash === '#/cafeteria') return 'cafeteria'
  return 'launcher'
}

export function routeAllowed(route: SystemRoute, access: ModuleAccess): boolean {
  if (route === 'cleaning') return access.cleaning
  if (route === 'cafeteria') return access.cafeteria
  return true
}

export function routeHash(route: SystemRoute): string {
  return route === 'launcher' ? '#/' : `#/${route}`
}
