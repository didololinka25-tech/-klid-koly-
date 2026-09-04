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
const seededManualValues = migration.slice(0, migration.indexOf("on conflict (entry_key)"));

test("03800 bezpečně doplní všechny potvrzené praktické návody", () => {
  for (const key of expectedKeys) assert.match(migration, new RegExp(`'${key}'`));
  assert.match(migration, /begin;[\s\S]*insert into public\.manual_entries[\s\S]*on conflict \(entry_key\) do update set[\s\S]*commit;/i);
  assert.doesNotMatch(migration, /delete\s+from|truncate\s+|cleaning_completions|attendance|cleaning_planner/i);
  assert.match(migration, /count\(\*\)[\s\S]*cardinality\(expected_keys\)/i);
});

test("03800 neobsahuje neověřené dávkování ani parametry stroje", () => {
  assert.doesNotMatch(seededManualValues, /1\s*:\s*(?:5|10)/);
  assert.doesNotMatch(seededManualValues, /(?:20|30)\s*ml|3\s*l\s+nádrž|1\s*%|[12]\s*kapk/i);
  assert.doesNotMatch(seededManualValues, /víčko nádrže slouží jako odměrka/i);
  assert.doesNotMatch(seededManualValues, /modrý strojový saponát/i);
  assert.doesNotMatch(seededManualValues, /Carpet Complete Kit pro SC100 ve škole máme/i);
  assert.match(seededManualValues, /dávkování doplní správce až po ověření/i);
  assert.match(seededManualValues, /Mýval nelij do Nilfisk SC100 bez výslovného potvrzení výrobce a školy/i);
  assert.match(seededManualValues, /Pouze prostředek určený výrobcem pro tento stroj a povrch/i);
});

test("potvrzené školní barvy hadrů a pytlů zůstávají přesné", () => {
  assert.match(migration, /Modrý hadr je určený pro okna a zrcadla/);
  assert.match(migration, /Žlutý hadr používej pouze na WC/);
  assert.match(migration, /Tříděný odpad → modrý pytel 60 l/);
  assert.match(migration, /Plasty → žlutý pytel 35 l/);
  assert.match(migration, /Běžné koše → bílý pytel 25 l/);
  assert.match(migration, /Mini koše → bílý pytel 10 l/);
});

test("všechny entry_key jsou v seed části právě jednou a vazby aktivit zůstávají", () => {
  for (const key of expectedKeys) {
    assert.equal(seededManualValues.match(new RegExp(`'${key}'`, "g"))?.length, 1, key);
  }
  assert.match(seededManualValues, /'guide-toilet'[\s\S]*?'\{toilet\}'/);
  assert.match(seededManualValues, /'guide-floors'[\s\S]*?'\{vacuum,mop\}'/);
  assert.match(seededManualValues, /'guide-windows'[\s\S]*?'\{windows\}'/);
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
