import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProcessContext } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { DIMENSION_DEFS, DIMENSIONS, type Dimension } from "../dimensions";
import { requireLeafDimension } from "../processes/common";
import { accountingHarness, newId, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
let accountId: string;
let journalId: string;
beforeAll(async () => {
  h = await accountingHarness({ companies: 2 });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  accountId = (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '110505'`)[0]!.id;
  journalId = (await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`)[0]!.id;
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const create = (dim: Dimension, input: object) => h.run<{ id: string }>(h.admin, `accounting.${dim}.create`, input);
const update = (dim: Dimension, input: object) => h.run<{ id: string }>(h.admin, `accounting.${dim}.update`, input);
const row = async (dim: Dimension, id: string) =>
  (await h.sql`select * from ${h.sql(`accounting.${DIMENSION_DEFS[dim].table}`)} where id = ${id}`)[0]!;

/** A draft entry with one line carrying the node, as the service role. */
async function lineWith(dim: Dimension, nodeId: string) {
  const [entry] = await h.sql<{ id: string }[]>`insert into accounting.entries (company_id, journal_id, date) values (${h.companyId}, ${journalId}, current_date) returning id`;
  const column = DIMENSION_DEFS[dim].column;
  await h.sql`insert into accounting.entry_lines ${h.sql({ company_id: h.companyId, entry_id: entry!.id, line_no: 1, account_id: accountId, debit: 10, [column]: nodeId })}`;
  return entry!.id;
}

describe("dimension processes", () => describe.each(DIMENSIONS)("%s", (dim) => {
  const code = (suffix: string) => `${dim.slice(0, 2).toUpperCase()}-${suffix}`;

  it("creates a group and a leaf, refuses a leaf parent, a cycle and a group→leaf with children", async () => {
    const group = await create(dim, { code: code("G1"), name: "Grupo uno", kind: "group" });
    const leaf = await create(dim, { code: code("L1"), name: "Hoja uno", kind: "leaf", parentId: group.id });
    expect(await row(dim, leaf.id)).toMatchObject({ code: code("L1"), kind: "leaf", parent_id: group.id, is_active: true });
    expect(await row(dim, group.id)).toMatchObject({ kind: "group", parent_id: null });

    // A leaf cannot be a parent; the parent must exist in this dimension.
    await expect(create(dim, { code: code("X1"), name: "Bajo hoja", kind: "leaf", parentId: leaf.id })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(create(dim, { code: code("X2"), name: "Padre inexistente", kind: "leaf", parentId: newId() })).rejects.toMatchObject({ code: "invalid_input" });
    // A duplicate code is refused.
    await expect(create(dim, { code: code("G1"), name: "Repetido", kind: "group" })).rejects.toMatchObject({ code: "invalid_input" });

    // A cycle: the group cannot move under its own descendant group, nor under itself.
    const sub = await create(dim, { code: code("G2"), name: "Subgrupo", kind: "group", parentId: group.id });
    await expect(update(dim, { id: group.id, parentId: sub.id })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(update(dim, { id: group.id, parentId: group.id })).rejects.toMatchObject({ code: "invalid_input" });
    // A group with children cannot become a leaf; an empty one can.
    await expect(update(dim, { id: group.id, kind: "leaf" })).rejects.toMatchObject({ code: "invalid_input" });
    await update(dim, { id: sub.id, kind: "leaf" });
    expect(await row(dim, sub.id)).toMatchObject({ kind: "leaf" });
    // Rename, re-parent to the root and back.
    await update(dim, { id: leaf.id, name: "Hoja renombrada", parentId: null });
    expect(await row(dim, leaf.id)).toMatchObject({ name: "Hoja renombrada", parent_id: null });
    await update(dim, { id: leaf.id, parentId: group.id });
    expect(await row(dim, leaf.id)).toMatchObject({ parent_id: group.id });
    // The code is the identity: it never changes.
    await expect(update(dim, { id: leaf.id, code: "ZZ" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a node of another company or another dimension is not a valid parent, and consult reads the masked view", async () => {
    const other = DIMENSIONS.find((d) => d !== dim)!;
    const foreign = await create(other, { code: code("F1"), name: "De otra dimensión", kind: "group" });
    await expect(create(dim, { code: code("X3"), name: "Padre ajeno", kind: "leaf", parentId: foreign.id })).rejects.toMatchObject({ code: "invalid_input" });
    const [mine] = await h.sql<{ id: string }[]>`select id from ${h.sql(`accounting.${DIMENSION_DEFS[dim].table}`)} where company_id = ${h.companyId} and code = ${code("G1")}`;
    expect(await h.run(h.contador, `accounting.${dim}.consult`, { id: mine!.id })).toMatchObject({ id: mine!.id, code: code("G1"), kind: "group" });
    await expect(h.run(h.contador, `accounting.${dim}.create`, { code: code("N1"), name: "No", kind: "leaf" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a leaf with lines cannot become a group or be deleted, only deactivated; an inactive leaf is refused on a new line", async () => {
    const leaf = await create(dim, { code: code("L9"), name: "Hoja con líneas", kind: "leaf" });
    await lineWith(dim, leaf.id);
    await expect(update(dim, { id: leaf.id, kind: "group" })).rejects.toMatchObject({ code: "invalid_input" });
    // No role may delete a node: the application role holds no delete privilege on the table.
    await expect(
      withClaims(h.sql, h.admin.claims, (tx) => tx`delete from ${tx(`accounting.${DIMENSION_DEFS[dim].table}`)} where id = ${leaf.id}`),
    ).rejects.toThrow(/permission denied/);
    // A leaf may take lines while active; once deactivated the entry validation refuses it.
    const check = (id: string) => h.sql.begin((tx) => requireLeafDimension({ tx, companyId: h.companyId } as unknown as ProcessContext, dim, id));
    await expect(check(leaf.id)).resolves.toBeUndefined();
    await update(dim, { id: leaf.id, isActive: false });
    await expect(check(leaf.id)).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("inactivo")] });
    // A group is refused as a line dimension too.
    const group = (await h.sql<{ id: string }[]>`select id from ${h.sql(`accounting.${DIMENSION_DEFS[dim].table}`)} where company_id = ${h.companyId} and code = ${code("G1")}`)[0]!;
    await expect(check(group.id)).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("hoja")] });
    await expect(check(newId())).rejects.toMatchObject({ code: "invalid_input" });
  });
}));
