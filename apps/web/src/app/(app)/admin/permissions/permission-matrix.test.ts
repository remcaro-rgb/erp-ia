import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { messages } from "@erp/i18n";
import type { PermissionsData } from "@/lib/admin/load";
import { PermissionMatrix } from "./permission-matrix";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/admin/actions", () => ({ adminAction: vi.fn() }));
vi.mock("@/lib/auth/step-up-client", () => ({ requestStepUp: vi.fn() }));

// OD-7 and M10: the matrix offers "todos / ninguno" per module and role (not for the system admin role), a live region
// for the count of staged changes, and the whole cell as the checkbox's target. Nothing is staged on first render.

const data: PermissionsData = {
  roles: [
    { id: "r-admin", name: "admin", description: "", isSystemAdmin: true, partyScope: "ambos" },
    { id: "r-ventas", name: "Ventas", description: "Vende", isSystemAdmin: false, partyScope: "clientes" },
  ],
  processes: [
    { id: "core.party.consult", module: "core", kind: "consult", entity: "core.party", entityLabel: "entity.core.party", stepUp: false },
    { id: "core.party.create", module: "core", kind: "create", entity: "core.party", entityLabel: "entity.core.party", stepUp: false },
  ],
  grants: { "r-admin": [], "r-ventas": ["core.party.consult"] },
};
const allGranted: PermissionsData = { ...data, grants: { ...data.grants, "r-ventas": ["core.party.consult", "core.party.create"] } };

const render = (d: PermissionsData) =>
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: "es-419", messages: messages("es-419"), timeZone: "America/Bogota" } as ComponentProps<typeof NextIntlClientProvider>, createElement(PermissionMatrix, { data: d })),
  );

describe("PermissionMatrix staging", () => {
  it("offers 'todos' for a module the role does not fully hold, and none for the system admin role", () => {
    const html = render(data);
    expect(html).toContain('aria-label="Dar a Ventas todos los procesos de Núcleo"');
    expect(html).not.toContain("Dar a admin");
    expect((html.match(/>todos</g) ?? []).length).toBe(1);
  });

  it("offers 'ninguno' once the role holds every process of the module", () => {
    expect(render(allGranted)).toContain('aria-label="Quitar a Ventas todos los procesos de Núcleo"');
  });

  it("starts with nothing staged: an empty live region, the idle note and no apply button", () => {
    const html = render(data);
    expect(html).toMatch(/<span role="status" class="erp-admin__pending"><\/span>/);
    expect(html).toContain("Sin cambios pendientes");
    expect(html).not.toContain("Aplicar cambios");
    expect(html).not.toContain("is-dirty");
    // The whole cell is the target of its checkbox.
    expect(html).toMatch(/<label class="erp-matrix__hit"[^>]*><input type="checkbox" aria-label="Ventas core.party.create"/);
  });
});
