import { documentLinkTrail } from "./trail.process";

export { BORRADOR_STATUS, LINK_KIND, linkEnd, LINKS_FROM_MAX, linksSyncInput, linksVoidInput, makeLinks } from "./links";
export type { LinkEnd, LinksApi, LinksSync, LinksVoid } from "./links";
export { documentLinkTrail, trailInput, trailNode, trailResult } from "./trail.process";
export type { TrailInput, TrailNode, TrailResult } from "./trail.process";

/** The document link processes of the kernel: the trail consult (the writers are ctx.links, not processes). */
export const LINK_PROCESSES = [documentLinkTrail];
