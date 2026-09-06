import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repositoryUrl = new URL('./cafeteria/cafeteriaRepository.ts', import.meta.url)

test('admin role select explicitně používá user_module_roles user_id FK', async () => {
  const source = await readFile(repositoryUrl, 'utf8')
  assert.match(source, /profiles!user_module_roles_user_id_fkey\(full_name\)/)
  assert.doesNotMatch(source, /select\('user_id,role,profiles\(full_name\)'\)/)
})

test('load při selhání dočasně loguje původní Supabase diagnostiku a chybu znovu vyhodí', async () => {
  const source = await readFile(repositoryUrl, 'utf8')
  const loadBlock = source.slice(source.indexOf('load: async'), source.indexOf('\n  },\n}', source.indexOf('load: async')))
  assert.match(source, /repositoryError\.supabaseError = error/)
  for (const field of ['code', 'message', 'details', 'hint']) assert.match(source, new RegExp(`${field}: original`))
  assert.match(loadBlock, /catch \(error\)[\s\S]*logCafeteriaLoadError\(error\)[\s\S]*throw error/)
})
