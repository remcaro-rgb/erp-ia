import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NavItem } from "../registry/types";
import type { Registry } from "../registry";

// User guides (docs/user-guide/es-419/*.md, rule 35): Markdown with a front matter of `title`, `routes` (the app
// routes the guide covers) and `processes` (the process ids it explains). The help index chunks them.

export interface Guide {
  file: string;
  title: string;
  routes: string[];
  processes: string[];
  /** The Markdown after the front matter. */
  body: string;
}

export interface GuideChunk {
  title: string;
  body: string;
}

/** About 500 tokens at 4 characters a token. */
export const CHUNK_CHARS = 2000;

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Reads the front matter (a flat subset of YAML: `key: value` and `key:` followed by `- item` lines) and the body. */
export function parseGuide(file: string, text: string): Guide {
  const source = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  const meta: Record<string, string | string[]> = {};
  if (match) {
    let list: string[] | undefined;
    for (const line of match[1]!.split("\n")) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && list) {
        list.push(unquote(item[1]!));
        continue;
      }
      const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
      if (!pair) continue;
      if (pair[2] === "") meta[pair[1]!] = list = [];
      else {
        meta[pair[1]!] = unquote(pair[2]!);
        list = undefined;
      }
    }
  }
  const body = (match ? source.slice(match[0].length) : source).trim();
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const list = (key: string) => (Array.isArray(meta[key]) ? (meta[key] as string[]) : []);
  return {
    file,
    title: typeof meta.title === "string" && meta.title !== "" ? meta.title : (heading ?? file.replace(/\.md$/, "")),
    routes: list("routes"),
    processes: list("processes"),
    body,
  };
}

/** Splits `text` into pieces of at most `max` characters, at line breaks and then at spaces. */
function split(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = "";
  const push = (piece: string, joiner: string) => {
    if (current !== "" && current.length + joiner.length + piece.length > max) {
      out.push(current);
      current = "";
    }
    current = current === "" ? piece : current + joiner + piece;
  };
  for (const line of text.split("\n")) {
    if (line.length <= max) push(line, "\n");
    else for (const word of line.split(" ")) push(word, " ");
  }
  if (current !== "") out.push(current);
  return out;
}

/**
 * Chunks a guide by heading first (`#`, `##`, `###`), then by size: blank-line separated blocks are packed up to
 * `maxChars` and a block longer than that is split at lines and words. A chunk's title is the guide's title, then
 * `Guide › Heading` for the sections below its first heading.
 */
export function chunkGuide(guide: Guide, maxChars: number = CHUNK_CHARS): GuideChunk[] {
  const sections: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  for (const line of guide.body.split("\n")) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) sections.push({ heading: heading[1]!, lines: [] });
    else sections.at(-1)!.lines.push(line);
  }
  const chunks: GuideChunk[] = [];
  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (text === "") continue;
    const title = section.heading === null || section.heading === guide.title ? guide.title : `${guide.title} › ${section.heading}`;
    let current = "";
    for (const block of text.split(/\n{2,}/).flatMap((b) => split(b.trim(), maxChars))) {
      if (current !== "" && current.length + 2 + block.length > maxChars) {
        chunks.push({ title, body: current });
        current = "";
      }
      current = current === "" ? block : `${current}\n\n${block}`;
    }
    if (current !== "") chunks.push({ title, body: current });
  }
  return chunks;
}

/**
 * Every guide of a folder in file name order, the guides of a module's subfolder included (`contabilidad/comprobantes.md`
 * is the guide `contabilidad/comprobantes.md`); a folder's `README.md` is an index for people, not a guide.
 */
export function loadGuides(dir: string): Guide[] {
  const names = (sub: string): string[] =>
    readdirSync(join(dir, sub), { withFileTypes: true })
      .flatMap((entry) => {
        const name = sub === "" ? entry.name : `${sub}/${entry.name}`;
        if (entry.isDirectory()) return names(name);
        return entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md" ? [name] : [];
      })
      .sort();
  return names("").map((name) => parseGuide(name, readFileSync(join(dir, name), "utf8")));
}

/** Screens outside the menus that a guide may cover: the sign-in pages. */
const STATIC_ROUTES = ["/", "/login", "/mfa/verify", "/mfa/enroll"];

/** The screens of the menus of the loaded modules (navigation and the screens their features unlock), group children included; a group's `#` is no screen. */
function menuRoutes(registry: Registry): string[] {
  const flatten = (items: readonly NavItem[]): NavItem[] => items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
  const hrefs = registry.modules().flatMap((m) => flatten([...m.navigation, ...m.features.flatMap((f) => f.nav ?? [])]).map((item) => item.href));
  return [...new Set(hrefs.filter((href) => href !== "#"))];
}

/** The menu routes of the loaded modules plus the home and sign-in pages. */
export function knownRoutes(registry: Registry): string[] {
  return [...new Set([...STATIC_ROUTES, ...menuRoutes(registry)])];
}

/**
 * What is wrong with the guides, as messages (empty when all is well): a guide with no routes, a route that is no
 * screen, a process the registry does not have, and a menu screen no guide covers (rule 35: a feature without its
 * guide is not finished). Run by `pnpm help:index` before it rebuilds the index, and by the repository's tests.
 */
export function guideProblems(guides: readonly Guide[], registry: Registry): string[] {
  const problems: string[] = [];
  const known = new Set(knownRoutes(registry));
  const covered = new Set<string>();
  for (const guide of guides) {
    if (guide.routes.length === 0) problems.push(`${guide.file}: no routes in the front matter`);
    for (const route of guide.routes) {
      const path = route.split("?")[0]!;
      covered.add(path);
      if (!known.has(path)) problems.push(`${guide.file}: unknown route ${route}`);
    }
    for (const id of guide.processes) {
      if (!registry.processes().some((p) => p.id === id)) problems.push(`${guide.file}: unknown process ${id}`);
    }
  }
  for (const href of menuRoutes(registry)) if (!covered.has(href)) problems.push(`no guide covers the menu route ${href}`);
  return problems;
}
