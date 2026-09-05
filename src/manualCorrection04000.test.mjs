import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration03800Buffer = readFileSync(
  new URL("../supabase/migrations/20260903003800_practical_cleaning_manuals_and_equipment.sql", import.meta.url),
);
const migration04000 = readFileSync(
  new URL("../supabase/migrations/20260905004000_correct_manual_nilfisk_and_laundry.sql", import.meta.url),
  "utf8",
);

function gitBlobSha(buffer) {
  return createHash("sha1")
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest("hex");
}

test("aplikovaná 03800 zůstává přesně beze změny", () => {
  assert.equal(gitBlobSha(migration03800Buffer), "212738a8c1bd63e4ec42afa5f68855ca3292a172");
});

test("04000 je malá atomická oprava pouze konkrétních manual_entries", () => {
  assert.match(migration04000, /^begin;[\s\S]*commit;\s*$/i);
  assert.doesNotMatch(migration04000, /\bdelete\b|\btruncate\b/i);
  assert.doesNotMatch(
    migration04000,
    /cleaning_tasks|cleaning_completions|attendance|planner|worker_work|calendar/i,
  );

  const updatedKeys = [...migration04000.matchAll(/where entry_key = '([^']+)'\s*;/g)]
    .map((match) => match[1]);
  assert.deepEqual(updatedKeys, [
    "guide-machine",
    "guide-machine-carpet",
    "guide-deep-clean",
    "guide-laundry",
  ]);
});

test("aktuální strojové karty používají pouze obecný název Nilfisk", () => {
  assert.match(migration04000, /title = 'Nilfisk – tvrdé podlahy'/);
  assert.match(migration04000, /title = 'Nilfisk – koberce'/);
  assert.match(migration04000, /Do Nilfisku nelij Mýval bez výslovného potvrzení výrobce a školy/);
  assert.match(migration04000, /active[\s\S]*ilike '%SC100%'/i);

  const updateValues = migration04000.slice(0, migration04000.indexOf("do $$"));
  assert.doesNotMatch(updateValues, /\bSC100\b/i);
});

test("praní už nepožaduje oddělování žlutých hadrů a WC pravidlo zůstává", () => {
  assert.match(
    migration04000,
    /entry_key = 'guide-laundry'[\s\S]*ilike '%žlut%hadr%'[\s\S]*ilike '%odděl%'/i,
  );
  assert.doesNotMatch(
    migration04000.slice(0, migration04000.indexOf("do $$")),
    /Žluté WC hadry drž odděleně|oddělování žlutých WC hadrů/i,
  );
  assert.match(migration04000, /Žlutý hadr používej pouze na WC/);
});
