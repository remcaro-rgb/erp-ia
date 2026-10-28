import dane from "../data/dane.json" with { type: "json" };

export type Department = { code: string; name: string };
export type Municipality = { code: string; name: string; departmentCode: string };

/** The 33 DANE departments (DIVIPOLA, 2 digits). */
export const DEPARTMENTS: Department[] = dane.departments;

/**
 * Municipalities (DIVIPOLA, 5 digits, the first 2 are the department). Partial seed: the municipalities used by Serena and the
 * prototype plus every departmental capital; the full ~1,120-row table is a phase 2 data load. Validation therefore checks
 * the code format and its department prefix, never membership in this list.
 */
export const MUNICIPALITIES: Municipality[] = dane.municipalities;

export const departmentName = (code: string): string | undefined => DEPARTMENTS.find((d) => d.code === code)?.name;
export const municipalityName = (code: string): string | undefined => MUNICIPALITIES.find((m) => m.code === code)?.name;
