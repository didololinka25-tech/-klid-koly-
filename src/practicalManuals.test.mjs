import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { manualEntryMatchesSearch } from "./manualSearch.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/20260903003800_practical_cleaning_manuals_and_equipment.sql", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const repository = readFileSync(new URL("./schoolRepository.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const expectedKeys = [
  "guide-cleaners-preparation", "guide-toilet", "guide-sink", "guide-drain",
  "guide-mirror", "guide-windows", "guide-doors", "guide-floors", "guide-stairs",
  "guide-carpet", "guide-deep-clean", "guide-wood", "guide-tables", "guide-storage",
  "guide-upholstery", "guide-trash", "guide-tools", "guide-laundry", "guide-machine",
  "guide-machine-carpet",
];

test("03800 bezpečně doplní všechny potvrzené praktické návody", () => {
  for (const key of expectedKeys) assert.match(migration, new RegExp(`'${key}'`));
  assert.match(migration, /begin;[\s\S]*insert into public\.manual_entries[\s\S]*on conflict \(entry_key\) do update set[\s\S]*commit;/i);
  assert.doesNotMatch(migration, /delete\s+from|truncate\s+|cleaning_completions|attendance|cleaning_planner/i);
  assert.match(migration, /count\(\*\)[\s\S]*cardinality\(expected_keys\)/i);
});

test("potvrzená ředění a bezpečnostní hranice nejsou nahrazena domyšleným dávkováním", () => {
  assert.match(migration, /Lili → 1 : 10/);
  assert.match(migration, /Medium → 1 : 10/);
  assert.match(migration, /Jasněnka → 1 : 10/);
  assert.match(migration, /Mýval → 1 : 10 běžně \/ 1 : 5 silná špína/);
  assert.match(migration, /Balzamína → 20 ml \/ 1 l vlažné vody/);
  assert.match(migration, /Přesnou dávku[\s\S]*zatím neuvádíme/);
  assert.match(migration, /Mýval není potvrzený pro nalití do Nilfisk SC100/);
  assert.match(migration, /modrý strojový saponát, ne Lili/i);
});

test("vyhledávání najde prostředky v názvu i obsahu návodu", () => {
  const entry = {
    id: "guide", entryType: "guide", title: "Nilfisk SC100 – tvrdé podlahy", category: "Technika",
    body: "", supplies: "Lili Medium Mýval Jasněnka", steps: "Použij prostředek na sklo.",
    warnings: "Nemíchej prostředky.", schoolNote: "Balzamína je mýdlový čistič.",
    markerColor: "", activityTypes: [], featured: true, active: true, sortOrder: 1,
  };
  for (const query of ["Lili", "Medium", "Mýval", "Jasněnka", "Balzamína", "Nilfisk"])
    assert.equal(manualEntryMatchesSearch(entry, query), true, query);
});

test("modal oddělí kroky, pomůcky a varování a zůstane mobilně bezpečný", () => {
  assert.match(appSource, /function ManualGuideText/);
  assert.match(appSource, /<ol className="manual-step-list">/);
  assert.match(appSource, /<section className="manual-warning">/);
  assert.match(styles, /\.manual-detail\s*\{[^}]*width:\s*min\(480px,\s*calc\(100vw - 24px\)\)[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.manual-line-list, \.manual-step-list\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(styles, /\.manual-detail-heading button\s*\{[^}]*min-height:\s*44px/s);
});

test("adminská editace i obrazový manuál zůstávají zachované", () => {
  assert.match(repository, /saveManualEntry:[\s\S]*from\('manual_entries'\)\.update/);
  assert.match(repository, /setManualEntryActive/);
  assert.match(appSource, /Upravit obsah/);
  assert.match(appSource, /manual-open-close-school\.jpg/);
});
