import { describe, expect, it } from "vitest";
import { FakeEmbedder, GatewayEmbedder, chunkGuide, guideProblems, loadGuides } from "@erp/kernel";
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
      expect.arrayContaining(["inicio.md", "ingreso-y-2fa.md", "navegacion.md", "terceros.md", "contactos.md", "productos.md", "categorias.md", "archivos.md", "datos-adicionales.md", "listados.md", "exportar.md", "importar.md", "soporte.md"]),
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
