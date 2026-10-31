import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule } from "../../module/define";
import { loadModules } from "../../module/loader";
import { defineProcess } from "../../process/define";
import { Registry } from "../../registry";
import { EMBEDDING_DIMENSIONS, FakeEmbedder, GatewayEmbedder } from "../embedder";
import { chunkGuide, guideProblems, knownRoutes, loadGuides, parseGuide } from "../guides";
import { processChunks } from "../process-chunks";
import { snippetOf } from "../search";

// The pure parts of the help index (Task 16): the fake embedder, guide parsing and chunking, one chunk per
// process with its deep link, and the snippet cap. The database parts are in help.integration.test.ts.

describe("FakeEmbedder", () => {
  const embedder = new FakeEmbedder();
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

  it("returns one deterministic, unit-length vector of 1536 dimensions per text", async () => {
    const [a, b] = await embedder.embed(["cómo exporto a excel", "cómo exporto a excel"]);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a).toEqual(b);
    expect(Math.sqrt(dot(a!, a!))).toBeCloseTo(1, 6);
  });

  it("gives a text with no indexable word a unit vector too (never zeros, whose cosine is NaN)", async () => {
    const vectors = await embedder.embed(["", "¿?", "a de"]);
    for (const v of vectors) expect(Math.sqrt(dot(v, v))).toBeCloseTo(1, 6);
    expect(vectors[0]).toEqual(vectors[1]);
  });

  it("puts texts that share words closer than unrelated ones, ignoring accents, case and verb endings", async () => {
    const [query, near, far] = await embedder.embed(["Cómo exporto a Excel", "Exportar un listado a Excel", "Activar la verificación en dos pasos"]);
    expect(dot(query!, near!)).toBeGreaterThan(dot(query!, far!));
  });
});

describe("GatewayEmbedder", () => {
  it("defaults to the embeddings model of the design and takes another gateway id", () => {
    expect(new GatewayEmbedder().modelId).toBe("openai/text-embedding-3-small");
    expect(new GatewayEmbedder("google/gemini-embedding-001").modelId).toBe("google/gemini-embedding-001");
  });
});

const GUIDE = `---
title: Exportar un listado
routes:
  - /parties
  - "/products"
processes:
  - kernel.export.run
---

# Exportar un listado

Cada listado tiene tres botones.

## Paso a paso

1. Abre el listado.
2. Pulsa Excel.

## Formatos

${"Un párrafo largo sobre los formatos de archivo. ".repeat(80)}

${"Otro párrafo largo sobre el contenido de cada archivo. ".repeat(80)}
`;

describe("parseGuide", () => {
  it("reads title, routes and processes from the front matter and keeps the body", () => {
    const guide = parseGuide("exportar.md", GUIDE);
    expect(guide).toMatchObject({ file: "exportar.md", title: "Exportar un listado", routes: ["/parties", "/products"], processes: ["kernel.export.run"] });
    expect(guide.body.startsWith("# Exportar un listado")).toBe(true);
  });

  it("reads an empty flat list (`processes: []`) as no entries", () => {
    expect(parseGuide("x.md", "---\ntitle: T\nroutes: []\nprocesses: []\n---\n# T")).toMatchObject({ routes: [], processes: [] });
  });

  it("falls back to the first heading for the title and to no routes without front matter", () => {
    const guide = parseGuide("x.md", "# Mi guía\n\ntexto");
    expect(guide).toMatchObject({ title: "Mi guía", routes: [], processes: [] });
  });
});

describe("chunkGuide", () => {
  const chunks = chunkGuide(parseGuide("exportar.md", GUIDE));

  it("splits by heading first and then by size, about 500 tokens (2000 characters) at most", () => {
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) expect(chunk.body.length).toBeLessThanOrEqual(2000);
    expect(chunks[0]!.title).toBe("Exportar un listado");
    expect(chunks.map((c) => c.title)).toContain("Exportar un listado › Paso a paso");
    expect(chunks.filter((c) => c.title === "Exportar un listado › Formatos").length).toBeGreaterThan(1);
  });

  it("never loses text: every word of the guide lands in some chunk", () => {
    const all = chunks.map((c) => c.body).join("\n");
    for (const word of ["tres botones", "Abre el listado", "Pulsa Excel"]) expect(all).toContain(word);
  });
});

describe("chunkGuide image lines", () => {
  it("a guide image line reaches its chunk as its alt text only", () => {
    const guide = parseGuide("plan.md", "# Plan\n\nAntes del árbol.\n\n![Plan de cuentas en vista Árbol](img/plan-de-cuentas-arbol.png)\n\nDespués.");
    const text = chunkGuide(guide).map((c) => c.body).join("\n");
    expect(text).toContain("Plan de cuentas en vista Árbol");
    expect(text).not.toContain("img/");
    expect(text).not.toContain("![");
  });
});

describe("processChunks", () => {
  const registry = new Registry();
  const partyCreate = defineProcess({
    id: "core.party.create",
    module: "core",
    kind: "create",
    feature: "core.parties",
    description: "Crea un tercero (cliente, proveedor o empleado) con sus datos fiscales DIAN",
    input: z.object({ legal_name: z.string(), tax_id: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async () => ({ id: "x" }),
  });
  const partyConsult = defineProcess({
    id: "core.party.consult",
    module: "core",
    kind: "consult",
    feature: "core.parties",
    description: "Consulta un tercero",
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async () => ({ id: "x" }),
  });
  const categoryCreate = defineProcess({
    id: "core.category.create",
    module: "core",
    kind: "create",
    feature: "core.products",
    description: "Crea una categoría de productos",
    input: z.object({ name: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async () => ({ id: "x" }),
  });
  const contactCreate = defineProcess({
    id: "core.contact.create",
    module: "core",
    kind: "create",
    feature: "core.parties",
    description: "Agrega un contacto a un tercero",
    input: z.object({ party_id: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async () => ({ id: "x" }),
  });
  const orphan = defineProcess({
    id: "core.sequence.next",
    module: "core",
    kind: "update",
    description: "Toma el siguiente número",
    input: z.object({}),
    output: z.object({}),
    handler: async () => ({}),
  });
  const importRun = defineProcess({
    id: "kernel.import.run",
    module: "kernel",
    kind: "update",
    description: "Importa un archivo",
    input: z.object({ entity: z.string() }),
    output: z.object({}),
    handler: async () => ({}),
  });
  const nav = [
    { id: "core.import", label: "nav.core.import", href: "/import", icon: "upload", process: "kernel.import.run" },
    { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users", feature: "core.parties" },
    { id: "core.products", label: "nav.core.products", href: "/products", icon: "package", feature: "core.products" },
    { id: "core.categories", label: "nav.core.categories", href: "/categories", icon: "tags", feature: "core.products" },
  ];
  loadModules(registry, [
    defineModule({ id: "kernel", version: "0.0.0", dependsOn: [], entities: [], processes: [importRun], features: [], events: { emits: [], consumes: {} }, navigation: [] }),
    defineModule({
      id: "core",
      version: "0.0.0",
      dependsOn: [],
      entities: [],
      processes: [partyCreate, partyConsult, categoryCreate, contactCreate, orphan],
      features: [
        { id: "core.parties", label: "f", processes: [partyCreate.id, partyConsult.id, contactCreate.id], entities: [], nav: [nav[1]!] },
        { id: "core.products", label: "f", processes: [categoryCreate.id], entities: [], nav: [nav[2]!, nav[3]!] },
      ],
      events: { emits: [], consumes: {} },
      navigation: nav,
    }),
  ]);
  const chunks = processChunks(registry);
  const by = (id: string) => chunks.find((c) => c.source === `process:${id}`)!;

  it("links a process a menu item of another module names by its `process` field (the kernel's import, shown by core)", () => {
    expect(by("kernel.import.run").href).toBe("/import");
  });

  it("makes one chunk per registered process: description plus the input field names", () => {
    expect(chunks).toHaveLength(registry.processes().length);
    expect(by("core.party.create").body).toContain("Crea un tercero (cliente, proveedor o empleado)");
    expect(by("core.party.create").body).toContain("legal_name");
    expect(by("core.party.create").body).toContain("tax_id");
  });

  it("links a create process to its screen with ?new=1, matching the nav item by the entity", () => {
    expect(by("core.party.create").href).toBe("/parties?new=1");
    expect(by("core.category.create").href).toBe("/categories?new=1");
  });

  it("links the other kinds to the screen without ?new=1, and a process with no matching screen to its feature's first one", () => {
    expect(by("core.party.consult").href).toBe("/parties");
    expect(by("core.contact.create").href).toBe("/parties");
    expect(by("core.sequence.next").href).toBeUndefined();
  });
});

describe("snippetOf", () => {
  it("keeps short text as is and cuts long text at a word to at most 300 characters", () => {
    expect(snippetOf("texto corto")).toBe("texto corto");
    const cut = snippetOf("palabra ".repeat(100));
    expect(cut.length).toBeLessThanOrEqual(300);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.endsWith(" …")).toBe(false);
  });

  it("collapses markdown whitespace and headings markers", () => {
    expect(snippetOf("# Título\n\n1. Abre   el listado\n2. Pulsa")).toBe("Título 1. Abre el listado 2. Pulsa");
  });
});

describe("guideProblems", () => {
  const registry = new Registry();
  const process = defineProcess({
    id: "core.party.consult",
    module: "core",
    kind: "consult",
    description: "Consulta un tercero",
    input: z.object({}),
    output: z.object({}),
    handler: async () => ({}),
  });
  const nav = { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users" };
  loadModules(registry, [
    defineModule({ id: "core", version: "0.0.0", dependsOn: [], entities: [], processes: [process], features: [], events: { emits: [], consumes: {} }, navigation: [nav] }),
  ]);
  const guide = (over: Partial<ReturnType<typeof parseGuide>> = {}) => ({ ...parseGuide("terceros.md", "---\ntitle: T\n---\n# T\ntexto"), routes: ["/parties"], processes: ["core.party.consult"], ...over });

  it("knows the menu routes of the loaded modules and the sign-in pages", () => {
    expect(knownRoutes(registry)).toEqual(expect.arrayContaining(["/", "/login", "/mfa/verify", "/mfa/enroll", "/parties"]));
  });

  it("reads the routes of a menu group's children and ignores the group's own placeholder href", () => {
    const grouped = new Registry();
    const child = { id: "acc.a", label: "nav.acc.a", href: "/acc/a", icon: "users" };
    loadModules(grouped, [
      defineModule({ id: "acc", version: "0.0.0", dependsOn: [], entities: [], processes: [], features: [], events: { emits: [], consumes: {} }, navigation: [{ id: "acc.group", label: "nav.acc.group", href: "#", icon: "users", children: [child] }] }),
    ]);
    expect(knownRoutes(grouped)).toContain("/acc/a");
    expect(knownRoutes(grouped)).not.toContain("#");
    expect(guideProblems([{ ...guide(), routes: ["/acc/a"], processes: [] }], grouped)).toEqual([]);
    expect(guideProblems([{ ...guide(), routes: ["/login"], processes: [] }], grouped)).toEqual(["no guide covers the menu route /acc/a"]);
  });

  it("accepts a guide whose routes and processes exist", () => {
    expect(guideProblems([guide()], registry)).toEqual([]);
  });

  it("flags a guide without routes, an unknown route (ignoring the query) and an unregistered process", () => {
    expect(guideProblems([guide({ routes: [] })], registry)).toContain("terceros.md: no routes in the front matter");
    expect(guideProblems([guide({ routes: ["/parties?new=1"] })], registry)).toEqual([]);
    expect(guideProblems([guide({ routes: ["/nada"] })], registry)).toContain("terceros.md: unknown route /nada");
    expect(guideProblems([guide({ processes: ["core.party.nope"] })], registry)).toEqual(["terceros.md: unknown process core.party.nope"]);
  });

  it("flags a menu screen no guide covers (rule 35: a feature without its guide is not finished)", () => {
    expect(guideProblems([guide({ routes: ["/login"] })], registry)).toEqual(["no guide covers the menu route /parties"]);
  });
});

describe("loadGuides", () => {
  it("reads the guides of module subfolders as folder/name.md and skips every README", () => {
    const dir = mkdtempSync(join(tmpdir(), "guides-"));
    try {
      mkdirSync(join(dir, "contabilidad"));
      writeFileSync(join(dir, "inicio.md"), "---\ntitle: A\nroutes:\n  - /\n---\n# A\n");
      writeFileSync(join(dir, "README.md"), "# Índice\n");
      writeFileSync(join(dir, "contabilidad", "informes.md"), "---\ntitle: B\nroutes:\n  - /\n---\n# B\n");
      writeFileSync(join(dir, "contabilidad", "README.md"), "# Índice\n");
      expect(loadGuides(dir).map((g) => g.file)).toEqual(["contabilidad/informes.md", "inicio.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
