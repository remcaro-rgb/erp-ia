// Who may read an entity's grid (design §9, §5.12, rule 13): the company must be entitled to the feature that
// declares the entity (or its module), and one of the caller's roles must be allowed the entity's own consult
// process. An entity without one cannot be read through the grid. The read itself runs under the caller's claims
// over the masked view. The check lives in the kernel, shared with the assistant's `data.query`.

export { consultProcessesOf, gridDenial, gridEntity } from "@erp/kernel";
export type { GridDenial } from "@erp/kernel";
