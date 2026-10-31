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
    { id: "core.party.consult", description: "Consulta terceros", module: "core", kind: "consult", entity: "core.party", entityLabel: "entity.core.party", stepUp: false, admin: false },
    { id: "core.party.create", description: "Crea un tercero", module: "core", kind: "create", entity: "core.party", entityLabel: "entity.core.party", stepUp: false, admin: false },
    { id: "kernel.admin.role.create", description: "Crea un rol", module: "kernel", kind: "create", entity: "kernel.admin.role", entityLabel: "feature.kernel.admin", stepUp: true, admin: true },
    { id: "kernel.import.run", description: "Importa datos", module: "kernel", kind: "create", entity: "kernel.import", entityLabel: "entity.kernel.import", stepUp: false, admin: false },
  ],
  grants: { "r-admin": [], "r-ventas": ["core.party.consult", "kernel.import.run"] },
};
const allGranted: PermissionsData = { ...data, grants: { ...data.grants, "r-ventas": ["core.party.consult", "core.party.create", "kernel.import.run"] } };

const render = (d: PermissionsData) =>
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: "es-419", messages: messages("es-419"), timeZone: "America/Bogota" } as ComponentProps<typeof NextIntlClientProvider>, createElement(PermissionMatrix, { data: d })),
  );

describe("PermissionMatrix staging", () => {
  it("offers 'todos' for a module the role does not fully hold, and none for the system admin role", () => {
    const html = render(data);
    expect(html).toContain('aria-label="Dar a Ventas todos los procesos de Núcleo"');
    expect(html).not.toContain("Dar a admin");
    expect(html).toContain('aria-label="Dar a Ventas todos los procesos de Núcleo"');
  });

  it("locks the administration processes for other roles, and the module button leaves them out", () => {
    const html = render(data);
    // Ventas holds every process of Sistema it may hold (kernel.import.run): the button takes them away, it never
    // offers an administration process.
    expect(html).toContain('aria-label="Quitar a Ventas todos los procesos de Sistema"');
    expect(html).toMatch(/<label class="erp-matrix__hit" title="Solo el rol admin ejecuta los procesos de administración"><input type="checkbox" aria-label="Ventas Crea un rol" disabled=""/);
  });

  it("offers no module button when every process of the module is an administration one", () => {
    const onlyAdmin: PermissionsData = { ...data, processes: data.processes.filter((p) => p.admin), grants: { "r-admin": [], "r-ventas": [] } };
    const html = render(onlyAdmin);
    expect(html).not.toContain("todos los procesos de Sistema");
  });

  it("offers 'ninguno' once the role holds every process of the module", () => {
    expect(render(allGranted)).toContain('aria-label="Quitar a Ventas todos los procesos de Núcleo"');
    expect(render(allGranted)).toContain('aria-label="Quitar a Ventas todos los procesos de Sistema"');
  });

  it("starts with nothing staged: an empty live region, the idle note and no apply button", () => {
    const html = render(data);
    expect(html).toMatch(/<span role="status" class="erp-admin__pending"><\/span>/);
    expect(html).toContain("Sin cambios pendientes");
    expect(html).not.toContain("Aplicar cambios");
    expect(html).not.toContain("is-dirty");
    // The whole cell is the target of its checkbox.
    expect(html).toMatch(/<label class="erp-matrix__hit"[^>]*><input type="checkbox" aria-label="Ventas Crea un tercero"/);
  });
});

describe("PermissionMatrix labels (T11)", () => {
  it("names each row by what the process does; its id is secondary, in mono", () => {
    const html = render(allGranted);
    expect(html).toContain(">Crea un tercero</span>");
    expect(html).toContain('<span class="erp-hint erp-mono">core.party.create</span>');
    expect(html).not.toMatch(/<span class="erp-mono erp-small">core\.party/);
  });
});
