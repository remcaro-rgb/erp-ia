import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeEmbedder, GatewayEmbedder, chunkGuide, guideProblems, knownRoutes, loadGuides } from "@erp/kernel";
import { GUIDES_DIR, loadAppRegistry, pickEmbedder, policyEmbeddingModel } from "../help-index";
import { MissingModelPolicy } from "@erp/agent";

// `pnpm help:index` (Task 16): the user guides in docs/user-guide/es-419 against the modules the app loads
// (apps/web/src/lib/server/runtime.ts). A guide that names a screen or process that does not exist, or a menu screen
// without a guide, fails here and in the script (rule 35).

describe("the user guides", () => {
  const registry = loadAppRegistry();
  const guides = loadGuides(GUIDES_DIR);

  it("exist for every shipped feature", () => {
    expect(guides.map((g) => g.file)).toEqual(
      expect.arrayContaining(["inicio.md", "ingreso-y-2fa.md", "navegacion.md", "terceros.md", "contactos.md", "productos.md", "categorias.md", "archivos.md", "datos-adicionales.md", "listados.md", "exportar.md", "importar.md", "soporte.md", "comisiones.md"]),
    );
  });

  it("name real screens and processes, and every menu screen has a guide", () => {
    expect(guideProblems(guides, registry)).toEqual([]);
  });

  it("have a title, steps to follow and chunks of about 500 tokens", () => {
    for (const guide of guides) {
      expect(guide.title, guide.file).not.toBe("");
      expect(guide.body.length, guide.file).toBeGreaterThan(400);
      const chunks = chunkGuide(guide);
      expect(chunks.length, guide.file).toBeGreaterThan(0);
      for (const chunk of chunks) expect(chunk.body.length, guide.file).toBeLessThanOrEqual(2000);
    }
  });
});

describe("the accounting guides (phase 2A, rule 35)", () => {
  const registry = loadAppRegistry();
  const guides = loadGuides(GUIDES_DIR);
  const FILES = [
    "plan-de-cuentas.md", "comprobantes.md", "centros-de-costo.md", "auxiliares-abiertos-e-items.md", "unidades-de-negocio.md", "consulta-de-movimientos.md",
    "controles-y-cierre.md", "seguridad-por-cuenta.md", "exogena.md", "cartera-por-edades.md", "periodos-y-cierre.md", "reglas-contables.md", "informes.md",
    "pendientes-de-contabilizar.md",
  ];
  const accounting = guides.filter((g) => g.file.startsWith("contabilidad/"));

  it("loads the accounting module and knows every route of its menu, group children included", () => {
    expect(knownRoutes(registry)).toEqual(
      expect.arrayContaining(["/accounting/entries", "/accounting/movements", "/accounting/accounts", "/accounting/cost-centers", "/accounting/open-auxiliaries", "/accounting/items", "/accounting/business-units", "/accounting/journals", "/accounting/periods", "/accounting/reports", "/accounting/posting"]),
    );
    expect(knownRoutes(registry)).not.toContain("#");
  });

  it("has the fourteen guides of the plan, each indexed under a menu route and with every process it names registered", () => {
    expect(accounting.map((g) => g.file).sort()).toEqual(FILES.map((f) => `contabilidad/${f}`).sort());
    for (const guide of accounting) expect(guide.processes.length, guide.file).toBeGreaterThan(0);
    expect(guideProblems(guides, registry)).toEqual([]);
  });

  it("answers '¿cómo cierro el mes?' from periodos-y-cierre.md", async () => {
    const chunks = guides.flatMap((guide) => chunkGuide(guide).map((chunk) => ({ file: guide.file, text: `${chunk.title}\n${chunk.body}` })));
    const embedder = new FakeEmbedder();
    const [query] = await embedder.embed(["¿cómo cierro el mes?"]);
    const vectors = await embedder.embed(chunks.map((c) => c.text));
    const score = (v: number[]) => v.reduce((sum, x, i) => sum + x * query![i]!, 0);
    const best = chunks.map((c, i) => ({ file: c.file, score: score(vectors[i]!) })).sort((a, b) => b.score - a.score)[0]!;
    expect(best.file).toBe("contabilidad/periodos-y-cierre.md");
  });
});

describe("pickEmbedder", () => {
  it("uses the gateway when a key is set and the fake embedder (said out loud) when not", () => {
    expect(pickEmbedder({ AI_GATEWAY_API_KEY: "key" }).embedder).toBeInstanceOf(GatewayEmbedder);
    const without = pickEmbedder({});
    expect(without.embedder).toBeInstanceOf(FakeEmbedder);
    expect(without.name).toMatch(/FakeEmbedder/);
  });
});

describe("policyEmbeddingModel", () => {
  it("embeds with the model the policy table names for embeddings (rule 26)", async () => {
    const warnings: string[] = [];
    expect(await policyEmbeddingModel(async () => ({ primary: "openai/text-embedding-3-small", fallbacks: ["x/y"] }), (m) => warnings.push(m))).toBe("openai/text-embedding-3-small");
    expect(warnings).toEqual([]);
    expect(pickEmbedder({ AI_GATEWAY_API_KEY: "key" }, "openai/text-embedding-3-small").name).toContain("openai/text-embedding-3-small");
  });

  it("falls back to the code default only when the policy table has no row, and says so", async () => {
    const warnings: string[] = [];
    const model = await policyEmbeddingModel(async () => {
      throw new MissingModelPolicy("embeddings");
    }, (m) => warnings.push(m));
    expect(model).toBe("openai/text-embedding-3-small");
    expect(warnings[0]).toMatch(/no model policy/);
    await expect(policyEmbeddingModel(async () => { throw new Error("db down"); }, () => {})).rejects.toThrow("db down");
  });
});

describe("the entity types guides (phase 2A.5, rule 35)", () => {
  const registry = loadAppRegistry();
  const guides = loadGuides(GUIDES_DIR);
  const NEW = ["maestros-y-documentos.md", "plantillas-pdf.md", "notificaciones.md", "acceso-por-registro.md"];

  it("has the four new guides of Task 17, each naming registered processes and real screens", () => {
    expect(guides.map((g) => g.file)).toEqual(expect.arrayContaining(NEW));
    for (const file of NEW) expect(guides.find((g) => g.file === file)!.processes.length, file).toBeGreaterThan(0);
    expect(guideProblems(guides, registry)).toEqual([]);
  });

  it("explains the lifecycle, Notificar, Imprimir and the record access rules where the screens are", () => {
    const body = (file: string) => guides.find((g) => g.file === file)!.body;
    expect(body("maestros-y-documentos.md")).toMatch(/Guardar y enviar a aprobación/);
    expect(body("maestros-y-documentos.md")).toMatch(/Versiones/);
    expect(body("notificaciones.md")).toMatch(/copia oculta/);
    expect(body("acceso-por-registro.md")).toMatch(/solo restringen/i);
    expect(body("plantillas-pdf.md")).toMatch(/Imprimir/);
    expect(body("navegacion.md")).toMatch(/Contraer menú/);
    for (const file of ["terceros.md", "productos.md", "categorias.md", "contabilidad/comprobantes.md"]) expect(body(file), file).toMatch(/maestros-y-documentos\.md/);
  });
});

describe("the inventory guide (phase 2B Task 10, rule 35)", () => {
  const registry = loadAppRegistry();
  const guides = loadGuides(GUIDES_DIR);

  it("loads inventario and costos as the app does, and inventario.md covers their screens with registered processes", () => {
    expect(knownRoutes(registry)).toEqual(expect.arrayContaining(["/inventory/stock", "/inventory/movements", "/inventory/transfers", "/inventory/counts", "/costing/layers", "/costing/missing", "/costing/landed-costs", "/costing/settings"]));
    const guide = guides.find((g) => g.file === "inventario.md");
    expect(guide).toBeDefined();
    expect(guide!.processes).toEqual(expect.arrayContaining(["inventory.adjustment.post", "inventory.count.apply", "costing.landed_cost.void", "costing.settings.update"]));
    expect(guideProblems(guides, registry)).toEqual([]);
  });

  it("explains the steps a user needs: Despachar and Recibir, Aplicar conteo with the code, the transit bodega and costs pending", () => {
    const body = guides.find((g) => g.file === "inventario.md")!.body;
    expect(body).toMatch(/Despachar/);
    expect(body).toMatch(/Aplicar conteo/);
    expect(body).toMatch(/código de verificación/i);
    expect(body).toMatch(/Costos pendientes/);
  });
});

describe("the phase 2B guides (Task 27, rule 35)", () => {
  const registry = loadAppRegistry();
  const guides = loadGuides(GUIDES_DIR);
  const FILES = ["crm.md", "cotizaciones.md", "ventas.md", "pedidos.md", "entregas.md", "inventario.md", "costos.md", "facturacion.md", "facturacion-electronica.md", "pagos.md"];

  it("has a guide for every module of the sales chain, each naming registered processes, and every menu route covered", () => {
    expect(guides.map((g) => g.file)).toEqual(expect.arrayContaining(FILES));
    for (const file of FILES) expect(guides.find((g) => g.file === file)!.processes.length, file).toBeGreaterThan(0);
    expect(knownRoutes(registry)).toEqual(expect.arrayContaining(["/crm/quotes", "/sales/orders", "/sales/deliveries", "/invoicing/invoices", "/invoicing/notes", "/payments/receipts", "/costing/landed-costs"]));
    expect(guideProblems(guides, registry)).toEqual([]);
  });

  it("costos.md explains the weighted average, landed costs, costs pending and FIFO in phase 3", () => {
    const body = guides.find((g) => g.file === "costos.md")!.body;
    expect(body).toMatch(/promedio ponderado/);
    expect(body).toMatch(/Costos en destino/);
    expect(body).toMatch(/Costos pendientes/);
    expect(body).toMatch(/PEPS \(FIFO\)[^.]*fase 3/);
    expect(guides.find((g) => g.file === "costos.md")!.routes).toEqual(expect.arrayContaining(["/costing/layers", "/costing/missing", "/costing/landed-costs", "/costing/settings"]));
  });

  it("the README lists every guide", () => {
    const readme = readFileSync(join(GUIDES_DIR, "README.md"), "utf8");
    for (const guide of guides) expect(readme, guide.file).toContain(`(${guide.file})`);
  });
});
