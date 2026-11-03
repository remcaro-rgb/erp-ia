// The entities that open as a full page at /r/<entity>/<id> (design §5.16) and how to read them. Pure, so
// the page stays thin and the rules are unit-tested.

export interface RecordEntity {
  id: string;
  /** The consult process that returns the record as the caller may see it. */
  consult: string;
  /** The processes the Datos form saves through (rule 1). Empty: the entity has no such form (a Período is only shown; a Regla contable or Plantilla is created elsewhere). */
  create: string;
  update: string;
  /** Column of the consult row that names the record in the frame's title. */
  titleField: string;
  /** i18n key of the entity's noun for "Crear <entity>" (`nav.create.*`). */
  nounKey: string;
}

const RECORD_ENTITIES: readonly RecordEntity[] = [
  { id: "core.party", consult: "core.party.consult", create: "core.party.create", update: "core.party.update", titleField: "legal_name", nounKey: "nav.create.core.party" },
  { id: "core.product", consult: "core.product.consult", create: "core.product.create", update: "core.product.update", titleField: "description", nounKey: "nav.create.core.product" },
  {
    id: "core.product_category",
    consult: "core.category.consult",
    create: "core.category.create",
    update: "core.category.update",
    titleField: "name",
    nounKey: "nav.create.core.category",
  },
  // Comprobantes (accounting design §4.6, §8): the header and the lines are one record, saved by the draft processes; the number
  // is assigned on posting, so a draft has none yet.
  {
    id: "accounting.entry",
    consult: "accounting.entry.consult",
    create: "accounting.entry.create",
    update: "accounting.entry.update",
    titleField: "number",
    nounKey: "nav.create.accounting.entry",
  },
  // The accounting masters (accounting design §8, Task 28): the Cuenta, the four analytic nodes, the Fuente, the Plantilla de comprobante, the
  // Período and the Regla contable. A record with no create process has no `/new` form and no "Duplicar".
  { id: "accounting.account", consult: "accounting.account.consult", create: "accounting.account.create", update: "accounting.account.update", titleField: "code", nounKey: "nav.create.accounting.account" },
  { id: "accounting.cost_center", consult: "accounting.cost_center.consult", create: "accounting.cost_center.create", update: "accounting.cost_center.update", titleField: "name", nounKey: "nav.create.accounting.cost_center" },
  {
    id: "accounting.open_auxiliary",
    consult: "accounting.open_auxiliary.consult",
    create: "accounting.open_auxiliary.create",
    update: "accounting.open_auxiliary.update",
    titleField: "name",
    nounKey: "nav.create.accounting.open_auxiliary",
  },
  { id: "accounting.item", consult: "accounting.item.consult", create: "accounting.item.create", update: "accounting.item.update", titleField: "name", nounKey: "nav.create.accounting.item" },
  {
    id: "accounting.business_unit",
    consult: "accounting.business_unit.consult",
    create: "accounting.business_unit.create",
    update: "accounting.business_unit.update",
    titleField: "name",
    nounKey: "nav.create.accounting.business_unit",
  },
  { id: "accounting.journal", consult: "accounting.journal.consult", create: "accounting.journal.create", update: "accounting.journal.update", titleField: "code", nounKey: "nav.create.accounting.journal" },
  { id: "accounting.entry_template", consult: "accounting.entry_template.consult", create: "", update: "accounting.entry_template.update", titleField: "name", nounKey: "nav.create.accounting.entry_template" },
  { id: "accounting.period", consult: "accounting.period.consult", create: "", update: "", titleField: "starts_on", nounKey: "nav.create.accounting.period" },
  { id: "accounting.posting_rule", consult: "accounting.posting_rule.consult", create: "", update: "accounting.posting_rule.update", titleField: "name", nounKey: "nav.create.accounting.posting_rule" },
];

/** The id of a record not created yet: `/r/<entity>/new` opens the empty form. */
export const NEW_RECORD_ID = "new";

/** Every entity with a full record page. */
export const recordEntities = (): readonly RecordEntity[] => RECORD_ENTITIES;

/** The entity config, or null for an entity that has no full page (also for inherited object keys). */
export const recordEntity = (id: string): RecordEntity | null => RECORD_ENTITIES.find((e) => e.id === id) ?? null;
