// The entities that open as a full page at /r/<entity>/<id> (design §5.16) and how to read them. Pure, so
// the page stays thin and the rules are unit-tested.

export interface RecordEntity {
  id: string;
  /** The consult process that returns the record as the caller may see it. */
  consult: string;
  /** The processes the Datos form saves through (rule 1). */
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
];

/** The id of a record not created yet: `/r/<entity>/new` opens the empty form. */
export const NEW_RECORD_ID = "new";

/** The entity config, or null for an entity that has no full page (also for inherited object keys). */
export const recordEntity = (id: string): RecordEntity | null => RECORD_ENTITIES.find((e) => e.id === id) ?? null;
