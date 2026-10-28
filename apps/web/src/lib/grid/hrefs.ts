// The grid screen of each entity that has one (design §9): where the assistant's "Abrir como grid" lands. Pure.

const GRID_HREFS: Readonly<Record<string, string>> = {
  "core.party": "/parties",
  "core.product": "/products",
  "core.product_category": "/categories",
};

/** The screen that lists `entity`, or undefined for an entity without a grid (also for inherited object keys). */
export const gridHref = (entity: string): string | undefined => (Object.hasOwn(GRID_HREFS, entity) ? GRID_HREFS[entity] : undefined);

/** Entities with a grid screen. */
export const gridEntities = (): string[] => Object.keys(GRID_HREFS);
