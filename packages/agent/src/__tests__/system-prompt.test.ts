import { describe, expect, it } from "vitest";
import { buildSystemPrompt, type PromptFacts } from "../runtime/system-prompt";

// The system prompt (design §7.1): Spanish, assembled from the company, the user, their roles and permissions, the
// locale, the screen, the help chunks for the question, and the rule that writes always go through a confirmation card.

const facts: PromptFacts = {
  company: { name: "Café del Norte S.A.S.", taxId: "900373115", countryCode: "CO", currency: "COP", timeZone: "America/Bogota" },
  user: { name: "Ana Gómez" },
  roles: ["admin"],
  permissions: { core: { consult: 3, create: 2, update: 1, delete: 0 }, support: { consult: 1, create: 1, update: 0, delete: 0 } },
  locale: "es-419",
  today: "2026-10-28",
  screen: { route: "/parties", record: { entity: "core.party", id: "0190d8b2-1c1e-7000-8000-000000000000" } },
  help: [
    { title: "Crear un tercero", snippet: "Abre Terceros y pulsa Nuevo.", source: "guide:terceros.md", href: "/parties?new=1" },
    { title: "Exportar", snippet: "Usa los botones PDF, Excel y CSV.", source: "guide:exportar.md" },
  ],
};

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt(facts);

  it("is written in Spanish and names the company, the user and the roles", () => {
    expect(prompt).toContain("Eres el asistente");
    expect(prompt).toContain("Café del Norte S.A.S.");
    expect(prompt).toContain("NIT 900373115");
    expect(prompt).toContain("Ana Gómez");
    expect(prompt).toContain("admin");
    expect(prompt).toContain("es-419");
    expect(prompt).toContain("America/Bogota");
  });

  it("summarises the permissions per module", () => {
    expect(prompt).toMatch(/core: 3 consultas, 2 creaciones, 1 actualizaciones, 0 eliminaciones/);
    expect(prompt).toMatch(/support: 1 consultas, 1 creaciones/);
  });

  it("states the screen context and the help chunks with their links", () => {
    expect(prompt).toContain("/parties");
    expect(prompt).toContain("core.party 0190d8b2-1c1e-7000-8000-000000000000");
    expect(prompt).toContain("Crear un tercero");
    expect(prompt).toContain("/parties?new=1");
    expect(prompt).toContain("Usa los botones PDF, Excel y CSV.");
  });

  it("says every write needs the user's confirmation and money is written as $ 1.234.567,00", () => {
    expect(prompt).toMatch(/confirmación/);
    expect(prompt).toContain("$ 1.234.567,00");
  });

  it("works without a screen and without help", () => {
    const bare = buildSystemPrompt({ ...facts, screen: undefined, help: [] });
    expect(bare).not.toContain("Pantalla actual");
    expect(bare).not.toContain("Ayuda relacionada");
  });
});
