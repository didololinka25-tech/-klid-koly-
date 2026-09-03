import type { ManualEntry } from "./schoolRepository";

export const manualEntryMatchesSearch = (entry: ManualEntry, query: string) => {
  const normalized = query.trim().toLocaleLowerCase("cs");
  if (!normalized) return true;
  return [
    entry.title,
    entry.category,
    entry.body,
    entry.supplies,
    entry.steps,
    entry.warnings,
    entry.schoolNote,
  ].join(" ").toLocaleLowerCase("cs").includes(normalized);
};
