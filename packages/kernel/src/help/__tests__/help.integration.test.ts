import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { withClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { defineModule } from "../../module/define";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import type { Caller } from "../../process/context";
import { defineProcess } from "../../process/define";
import { runProcess } from "../../process/run";
import { Registry } from "../../registry";
import { EMBEDDING_DIMENSIONS, FakeEmbedder, type Embedder } from "../embedder";
import { buildHelpIndex } from "../index-builder";
import { searchHelp, setHelpEmbedder } from "../search";

// The help knowledge index (design §7, rule 35), migration 0018_kernel_help_index: guide chunks and one chunk per
// registered process, built with the service role, searched through kernel.help.search as the caller (platform
// rows for everyone, company rows only for that company's members).

// A locale of its own: the suite never touches the developer's real es-419 index.
const LOCALE = "xx-test";
// A second test locale, for company notes.
const OTHER_LOCALE = "xx-other";

const GUIDES: Record<string, string> = {
  "exportar.md": `---
title: Exportar un listado a PDF, Excel o CSV
routes:
  - /parties
---

# Exportar un listado a PDF, Excel o CSV

Cada listado tiene tres botones para exportar: PDF, Excel y CSV. El archivo trae lo que muestra la pantalla.

## Paso a paso

1. Abre el listado y filtra lo que quieres.
2. Pulsa Excel para exportar a Excel.
`,
  "inicio.md": `---
title: Primeros pasos
routes:
  - /
---

# Primeros pasos

Ingresa con tu correo y tu contraseña y elige la empresa con la que vas a trabajar.
`,
  "seguridad.md": `---
title: Ingreso y verificación en dos pasos
routes:
  - /login
---

# Ingreso y verificación en dos pasos

Activa la verificación en dos pasos con una app de autenticación y el código de seis dígitos.
`,
  // Only in this fixture, never in the real index: lets the locale tests tell the two apart.
  "solo-pruebas.md": `---
title: Guía solo de pruebas
routes:
  - /login
---

# Guía solo de pruebas

Zarzaparrilla cuántica del laboratorio de pruebas.
`,
};

function fakeCore() {
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
  const nav = { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users", feature: "core.parties" };
  return defineModule({
    id: "core",
    version: "0.0.0",
    dependsOn: [],
    entities: [],
    processes: [partyCreate],
    features: [{ id: "core.parties", label: "feature.core.parties", processes: [partyCreate.id], entities: [], nav: [nav] }],
    events: { emits: [], consumes: {} },
    navigation: [nav],
  });
}

describe("help knowledge index", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let guidesDir: string;
  let member: Caller;
  let memberB: Caller;
  let outsider: Caller;
  let noGrant: Caller;
  const embedder = new FakeEmbedder();
  const run = (caller: Caller, input: unknown): Promise<{ results: { title: string; snippet: string; source: string; href?: string }[] }> =>
    runProcess({ sql, registry }, caller, "kernel.help.search", input);
  const companyIds = () => seed.companies.map((c) => c.id);
  const count = async (where = sql`true`) => (await sql<{ n: number }[]>`select count(*)::int as n from kernel.help_chunks where ${where}`)[0]!.n;

  beforeAll(async () => {
    sql = testDb();
    guidesDir = mkdtempSync(join(tmpdir(), "help-guides-"));
    for (const [file, text] of Object.entries(GUIDES)) writeFileSync(join(guidesDir, file), text);
    registry = new Registry();
    loadModules(registry, [kernelModule, fakeCore()]);
    seed = await seedTenant(sql, {
      companies: 2,
      users: [
        { name: "member", companies: [0, 1], role: "member" },
        { name: "outsider", companies: [1], role: "member" },
        { name: "nogrant", companies: [0], role: "member" },
      ],
    });
    for (const company of seed.companies) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.memberRoleId}, 'kernel.help.search')`;
    }
    const claims = (user: string, company: number) => ({ claims: { ...seed.claimsFor(seed.users[user]!, seed.companies[company]!.id), locale: LOCALE }, origin: "ui" as const });
    member = claims("member", 0);
    memberB = claims("member", 1);
    outsider = claims("outsider", 1);
    // A role of the company with no grant at all (the company admin runs every process by definition, 0021).
    const [bare] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${seed.companies[0]!.id}, 'sin_permisos') returning id`;
    noGrant = { ...claims("nogrant", 0), claims: { ...claims("nogrant", 0).claims, role_ids: [bare!.id] } };
    setHelpEmbedder(embedder);
    await buildHelpIndex(sql, embedder, { guidesDir, registry, locale: LOCALE });
  });
  afterAll(async () => {
    setHelpEmbedder(undefined);
    await sql`delete from kernel.help_chunks where locale in (${LOCALE}, ${OTHER_LOCALE})`;
    await sql`delete from kernel.llm_usage where scope = 'platform' and model = 'fake/hash-embedder'`;
    await sql`delete from kernel.llm_usage where company_id = any(${companyIds()}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds()}::uuid[])`;
    await seed.cleanup();
    rmSync(guidesDir, { recursive: true, force: true });
    await sql.end();
  });

  it("indexes the guide chunks and one chunk per registered process, all platform scope with a 1536-dimension embedding", async () => {
    const guides = await sql<{ source: string; href: string | null }[]>`select source, href from kernel.help_chunks where scope = 'platform' and locale = ${LOCALE} and source like 'guide:%'`;
    expect(new Set(guides.map((g) => g.source))).toEqual(new Set(["guide:exportar.md", "guide:inicio.md", "guide:seguridad.md", "guide:solo-pruebas.md"]));
    expect(Object.fromEntries(guides.map((g) => [g.source, g.href]))).toEqual({ "guide:exportar.md": "/parties", "guide:inicio.md": "/", "guide:seguridad.md": "/login", "guide:solo-pruebas.md": "/login" });
    const processes = await sql<{ source: string }[]>`select source from kernel.help_chunks where scope = 'platform' and locale = ${LOCALE} and source like 'process:%'`;
    expect(processes.map((p) => p.source).sort()).toEqual(registry.processes().map((p) => `process:${p.id}`).sort());
    const [dims] = await sql<{ dims: number; companies: number }[]>`select min(vector_dims(embedding))::int as dims, count(company_id)::int as companies from kernel.help_chunks where locale = ${LOCALE}`;
    expect(dims).toEqual({ dims: EMBEDDING_DIMENSIONS, companies: 0 });
  });

  it("answers 'cómo exporto a excel' with the export guide first", async () => {
    const { results } = await run(member, { query: "cómo exporto a excel" });
    expect(results[0]).toMatchObject({ source: "guide:exportar.md", href: "/parties" });
    expect(results[0]!.title).toContain("Exportar");
    expect(results[0]!.snippet.length).toBeLessThanOrEqual(300);
  });

  it("answers 'crear cliente' with the core.party.create chunk and its deep link", async () => {
    const { results } = await run(member, { query: "crear cliente" });
    expect(results[0]).toMatchObject({ source: "process:core.party.create", href: "/parties?new=1" });
  });

  it("caps results at the limit (default 5, at most 10) and rejects a larger limit", async () => {
    expect((await run(member, { query: "listado" })).results).toHaveLength(5);
    expect((await run(member, { query: "listado", limit: 2 })).results).toHaveLength(2);
    expect((await run(member, { query: "listado", limit: 10 })).results.length).toBeLessThanOrEqual(10);
    await expect(run(member, { query: "listado", limit: 11 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(member, { query: "  " })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("is a consult process of the kernel's help feature, behind the role matrix", async () => {
    const def = registry.process("kernel.help.search");
    expect(def).toMatchObject({ kind: "consult", feature: "kernel.help", module: "kernel" });
    expect(registry.module("kernel").features.find((f) => f.id === "kernel.help")?.processes).toEqual(["kernel.help.search"]);
    await expect(run(noGrant, { query: "exportar" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rebuilding replaces the platform chunks: no duplicates, removed guides disappear, edited text is searchable", async () => {
    const before = await count(sql`scope = 'platform' and locale = ${LOCALE}`);
    await buildHelpIndex(sql, embedder, { guidesDir, registry, locale: LOCALE });
    expect(await count(sql`scope = 'platform' and locale = ${LOCALE}`)).toBe(before);

    rmSync(join(guidesDir, "inicio.md"));
    writeFileSync(join(guidesDir, "seguridad.md"), GUIDES["seguridad.md"]!.replace("código de seis dígitos", "código de seis dígitos y la clave de respaldo"));
    await buildHelpIndex(sql, embedder, { guidesDir, registry, locale: LOCALE });
    expect(await count(sql`source = 'guide:inicio.md' and locale = ${LOCALE}`)).toBe(0);
    expect(await count(sql`scope = 'platform' and locale = ${LOCALE}`)).toBe(before - 1);
    const [chunk] = await sql<{ body: string }[]>`select body from kernel.help_chunks where source = 'guide:seguridad.md' and locale = ${LOCALE}`;
    expect(chunk!.body).toContain("clave de respaldo");
    writeFileSync(join(guidesDir, "inicio.md"), GUIDES["inicio.md"]!);
    await buildHelpIndex(sql, embedder, { guidesDir, registry, locale: LOCALE });
  });

  it("a rebuild that fails leaves the previous index untouched (delete and insert are one transaction)", async () => {
    const before = await sql`select source, body from kernel.help_chunks where scope = 'platform' and locale = ${LOCALE} order by source, body`;
    const broken: Embedder = { embed: async (texts) => texts.map((_, i) => (i === texts.length - 1 ? [0, 1] : new Array<number>(EMBEDDING_DIMENSIONS).fill(0.01))) };
    await expect(buildHelpIndex(sql, broken, { guidesDir, registry, locale: LOCALE })).rejects.toThrow();
    expect(await sql`select source, body from kernel.help_chunks where scope = 'platform' and locale = ${LOCALE} order by source, body`).toEqual(before);
    const down: Embedder = { embed: async () => { throw new Error("gateway down"); } };
    await expect(buildHelpIndex(sql, down, { guidesDir, registry, locale: LOCALE })).rejects.toThrow("gateway down");
    expect(await count(sql`scope = 'platform' and locale = ${LOCALE}`)).toBe(before.length);
  });

  it("shows a company chunk only to that company's members, in the active company", async () => {
    const [vector] = await embedder.embed(["política interna de devoluciones de la sucursal"]);
    const companyA = seed.companies[0]!.id;
    await sql`
      insert into kernel.help_chunks (scope, company_id, source, title, body, embedding, locale)
      values ('company', ${companyA}, 'company:devoluciones', 'Devoluciones de la sucursal', 'Política interna de devoluciones de la sucursal', ${`[${vector!.join(",")}]`}::extensions.vector, ${LOCALE})`;
    const query = { query: "política interna de devoluciones de la sucursal", limit: 10 };
    expect((await run(member, query)).results.map((r) => r.source)).toContain("company:devoluciones");
    // The same user with the other company active, and a member of the other company only: platform rows, not A's.
    expect((await run(memberB, query)).results.map((r) => r.source)).not.toContain("company:devoluciones");
    expect((await run(outsider, query)).results.map((r) => r.source)).not.toContain("company:devoluciones");
    expect((await run(outsider, query)).results.length).toBeGreaterThan(0);
  });

  const probe = (locale: string, company: number) => {
    const caller = (company === 0 ? member : memberB).claims;
    return withClaims(sql, { ...caller, locale }, (tx) =>
      searchHelp(tx, embedder, { query: "zarzaparrilla cuántica del laboratorio", limit: 10, companyId: caller.active_company_id, locale, fallbackLocale: LOCALE }),
    );
  };

  it("a caller whose locale has no platform index falls back to the fallback locale's chunks", async () => {
    expect((await probe("xx-none", 0)).map((r) => r.source)).toContain("guide:solo-pruebas.md");
  });

  it("a company note in the caller's locale never changes the help language: only platform chunks decide it", async () => {
    const [vector] = await embedder.embed(["nota interna de la sucursal"]);
    await sql`
      insert into kernel.help_chunks (scope, company_id, source, title, body, embedding, locale)
      values ('company', ${seed.companies[0]!.id}, 'company:nota', 'Nota', 'nota interna de la sucursal', ${`[${vector!.join(",")}]`}::extensions.vector, ${OTHER_LOCALE})`;
    // The user belongs to that company, has no platform index in xx-other, and still gets the platform guides.
    const sources = (await probe(OTHER_LOCALE, 0)).map((r) => r.source);
    expect(sources).toContain("guide:solo-pruebas.md");
    expect(sources).not.toContain("company:nota");
  });

  it("authenticated users read the index but cannot write it", async () => {
    await withClaims(sql, member.claims, async (tx) => {
      const rows = await tx`select count(*)::int as n from kernel.help_chunks where scope = 'platform'`;
      expect(rows[0]!.n).toBeGreaterThan(0);
    });
    const attempt = (fn: (tx: Parameters<Parameters<typeof withClaims>[2]>[0]) => Promise<unknown>) => withClaims(sql, member.claims, fn);
    await expect(attempt((tx) => tx`delete from kernel.help_chunks`)).rejects.toThrow();
    await expect(attempt((tx) => tx`update kernel.help_chunks set title = 'x'`)).rejects.toThrow();
    await expect(
      attempt((tx) => tx`insert into kernel.help_chunks (scope, source, title, body, embedding) values ('platform', 'x', 'x', 'x', ${`[${new Array(EMBEDDING_DIMENSIONS).fill(0).join(",")}]`}::extensions.vector)`),
    ).rejects.toThrow();
  });

  it("meters the question's embedding: one usage row of task embeddings for the caller, in the process transaction", async () => {
    const usage = () => sql<{ n: number; tokens: number }[]>`
      select count(*)::int as n, coalesce(sum(input_tokens), 0)::int as tokens from kernel.llm_usage
      where company_id = ${seed.companies[0]!.id} and user_id = ${seed.users.member!} and task = 'embeddings'`;
    const [before] = await usage();
    await run(member, { query: "cómo exporto a excel" });
    const [after] = await usage();
    expect(after!.n).toBe(before!.n + 1);
    expect(after!.tokens).toBeGreaterThan(before!.tokens);
    const [row] = await sql`select scope, provider, model, output_tokens, run_id from kernel.llm_usage
      where company_id = ${seed.companies[0]!.id} and user_id = ${seed.users.member!} order by created_at desc limit 1`;
    expect(row).toMatchObject({ scope: "company", provider: "fake", model: "fake/hash-embedder", output_tokens: 0, run_id: null });
  });

  it("an embedder that never answers is aborted: the search fails instead of holding the transaction open", async () => {
    const hanging: Embedder = {
      embed: (_texts, options) =>
        new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true })),
    };
    setHelpEmbedder(hanging);
    try {
      await expect(run(member, { query: "exportar" })).rejects.toMatchObject({ code: "handler_failed" });
    } finally {
      setHelpEmbedder(embedder);
    }
  }, 20_000);

  it("meters a rebuild of the index as one platform usage row", async () => {
    const platform = async () => (await sql<{ n: number }[]>`select count(*)::int as n from kernel.llm_usage where scope = 'platform' and model = 'fake/hash-embedder'`)[0]!.n;
    const before = await platform();
    await buildHelpIndex(sql, embedder, { guidesDir, registry, locale: LOCALE });
    expect(await platform()).toBe(before + 1);
    const [row] = await sql`select company_id, user_id, task, input_tokens from kernel.llm_usage where scope = 'platform' order by created_at desc limit 1`;
    expect(row).toMatchObject({ company_id: null, user_id: null, task: "embeddings" });
    expect(row!.input_tokens).toBeGreaterThan(0);
  });

  it("keeps a platform chunk free of a company and a company chunk tied to one", async () => {
    const vec = `[${new Array(EMBEDDING_DIMENSIONS).fill(0.1).join(",")}]`;
    await expect(sql`insert into kernel.help_chunks (scope, company_id, source, title, body, embedding) values ('platform', ${seed.companies[0]!.id}, 'x', 'x', 'x', ${vec}::extensions.vector)`).rejects.toThrow();
    await expect(sql`insert into kernel.help_chunks (scope, source, title, body, embedding) values ('company', 'x', 'x', 'x', ${vec}::extensions.vector)`).rejects.toThrow();
  });
});
