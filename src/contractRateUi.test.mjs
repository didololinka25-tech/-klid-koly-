import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')

test('editor existujícího i nového vztahu zobrazuje mobilní hodinovou sazbu', () => {
  assert.match(app, /Hodinová sazba[\s\S]*type="number"[\s\S]*inputMode="decimal"/)
  assert.match(app, /min="0\.01"[\s\S]*step="0\.01"/)
  assert.match(app, /value=\{editing\.hourlyRate \?\? ""\}/)
  assert.match(app, /<span>Kč\/h<\/span>/)
  assert.match(app, /hourlyRate: undefined[\s\S]*>\+ Přidat</)
})

test('repository načte sazbu, odešle ji do RPC a po uložení proběhne refetch', () => {
  assert.match(repository, /select\('id,worker_id,contract_type,valid_from,valid_to,hourly_rate/)
  assert.match(repository, /hourlyRate: row\.hourly_rate === null \? undefined : Number\(row\.hourly_rate\)/)
  assert.match(repository, /target_hourly_rate: contract\.hourlyRate \?\? null/)
  assert.match(app, /await schoolRepository\.saveWorkerContract\(contract\);[\s\S]*setWorkerContracts\(await schoolRepository\.workerContracts\(contract\.workerId\)\)/)
})

test('PWA po aktivaci nové verze obnoví starý otevřený klient', () => {
  assert.match(main, /navigator\.serviceWorker\.addEventListener\('controllerchange'/)
  assert.match(main, /window\.location\.reload\(\)/)
  assert.match(main, /registration\.update\(\)/)
})
