import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { messages } from "@erp/i18n";
import type { ExtraData } from "@/lib/admin/load";
import { ExtraScreen } from "./extra-screen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/admin/actions", () => ({ adminAction: vi.fn() }));
vi.mock("@/lib/auth/step-up-client", () => ({ requestStepUp: vi.fn() }));

// T13 (2026-10-31): Datos adicionales shows one entity at a time, chosen from a list, not every table at once.
const field = { key: "canal", label: "Canal", type: "text", rolesEnter: [], rolesEdit: [], rolesView: [] } as unknown as ExtraData["entities"][number]["customFields"][number];
const entity = (id: string, label: string, customFields: ExtraData["entities"][number]["customFields"]) => ({ id, label, customFields }) as unknown as ExtraData["entities"][number];
const data: ExtraData = {
  roles: [],
  entities: [entity("core.party", "entity.core.party", []), entity("core.product", "entity.core.product", [field]), entity("accounting.entry", "entity.accounting.entry", [])],
};
const render = () =>
  renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "es-419", messages: messages("es-419"), timeZone: "America/Bogota" } as ComponentProps<typeof NextIntlClientProvider>, createElement(ExtraScreen, { data })));

describe("ExtraScreen entity selector", () => {
  it("lists every entity in a selector and shows only the first one that has fields", () => {
    const html = render();
    expect((html.match(/<option/g) ?? []).length).toBe(3);
    expect((html.match(/<section/g) ?? []).length).toBe(1);
    expect(html).toContain("Producto (1)");
    expect(html).toContain("<b>Canal</b>");
  });
});
