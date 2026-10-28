import dane from "../data/dane.json" with { type: "json" };

export type Department = { code: string; name: string };
export type Municipality = { code: string; name: string; departmentCode: string };

/** The 33 DANE departments (DIVIPOLA, 2 digits). */
export const DEPARTMENTS: Department[] = dane.departments;

/**
 * Every DIVIPOLA municipality (5 digits, the first 2 are the department): the 1,122 rows of DANE's "Códigos DIVIPOLA" dataset
 * (datos.gov.co, gdxc-w37w: municipalities, Bogotá, San Andrés island and the non-municipalized areas) plus the two codes
 * DIAN table 13.4.3 accepts that the extract lacks (27086, 94663). Validation checks membership in this list.
 * Source and transformation: .superpowers/sdd/2026-10-27-phase-1-foundation/data-followup-report.md. Keep it sorted by code.
 */
export const MUNICIPALITIES: Municipality[] = dane.municipalities;

const DEPARTMENT_BY_CODE = new Map(DEPARTMENTS.map((d) => [d.code, d]));
const MUNICIPALITY_BY_CODE = new Map(MUNICIPALITIES.map((m) => [m.code, m]));

export const isMunicipalityCode = (code: string): boolean => MUNICIPALITY_BY_CODE.has(code);
export const departmentName = (code: string): string | undefined => DEPARTMENT_BY_CODE.get(code)?.name;
export const municipalityName = (code: string): string | undefined => MUNICIPALITY_BY_CODE.get(code)?.name;
