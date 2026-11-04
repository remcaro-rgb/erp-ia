import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { messages } from "@erp/i18n";
import type { UserPageData } from "@/lib/admin/load";
import { UserScreen } from "./user-screen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/users/x" }));
vi.mock("@/lib/admin/actions", () => ({ adminAction: vi.fn() }));
vi.mock("@/lib/auth/mfa-actions", () => ({ setUserMfaAction: vi.fn() }));
// The shell's tabs store is not mounted here: the page only titles its tab through it.
vi.mock("@erp/ui", async (original) => ({ ...(await original<typeof import("@erp/ui")>()), useTabs: () => () => {} }));

// A user's page under Administración › Usuarios (design §22.16, rule 21): every user reference links here. It shows the
// person's data (name, e-mail, mobile, locale, photo), their roles linked to Roles, whether their two-step verification
// is set up, their last activity from the audit, and offers "Editar" and "Desactivar" (or "Reactivar" when inactive).

const roles = [
  { id: "r-admin", name: "admin", description: "", partyScope: "ambos", isSystemAdmin: true },
  { id: "r-cajero", name: "cajero", description: "", partyScope: "clientes", isSystemAdmin: false },
];
const data: UserPageData = {
  member: {
    userId: "019a2c4e-0000-7000-8000-0000000000aa",
    name: "Marcela Rojas",
    email: "marcela@demo.local",
    mobileCc: "57",
    mobile: "3165550123",
    photo: null,
    roleIds: ["r-cajero"],
    mfaEnrolled: false,
    mfaRequired: false,
    locale: "es-419",
    isActive: true,
  },
  roles,
  lastActivity: "2026-10-29T14:05:00.000Z",
  self: false,
};

const render = (page: UserPageData) =>
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: "es-419", messages: messages("es-419"), timeZone: "America/Bogota" } as ComponentProps<typeof NextIntlClientProvider>, createElement(UserScreen, { data: page })),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("UserScreen", () => {
  it("shows the person's data, roles linked to Roles, the 2FA state and the last activity", () => {
    const html = render(data);
    const plain = text(html);
    expect(plain).toContain("Marcela Rojas");
    expect(plain).toContain("marcela@demo.local");
    expect(plain).toContain("+57 3165550123");
    expect(plain).toContain("Español (Latinoamérica)");
    expect(html).toMatch(/<a[^>]*href="\/admin\/roles"[^>]*>cajero<\/a>/);
    expect(plain).toContain("No configurada");
    expect(plain).toMatch(/Última actividad .*29.*oct.*2026/i);
    expect(plain).toContain("Activo");
    expect(html).toMatch(/<button[^>]*>Editar<\/button>/);
    expect(html).toMatch(/<button[^>]*>Desactivar<\/button>/);
    expect(html).not.toContain("Reactivar");
  });

  it("an inactive user is marked and offers Reactivar; 2FA set up reads Activa; no audit entry reads so", () => {
    const plain = text(render({ ...data, member: { ...data.member, isActive: false, mfaEnrolled: true }, lastActivity: null }));
    expect(plain).toContain("Inactivo");
    expect(plain).toContain("Reactivar");
    expect(plain).not.toContain("Desactivar");
    expect(plain).toContain("Activa");
    expect(plain).toContain("Sin actividad registrada");
  });

  it("the admin's own page cannot deactivate them: the button is disabled and says why", () => {
    const html = render({ ...data, self: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="No puedes desactivar tu propia cuenta"[^>]*>Desactivar<\/button>|<button[^>]*title="No puedes desactivar tu propia cuenta"[^>]*disabled=""[^>]*>Desactivar<\/button>/);
  });

  // Design §22.19, owner decision 2026-11-04: the admin removes a member's factor ("Quitar segundo paso", only when one is
  // set up) and requires or stops requiring it of anyone, an admin included (a switch). Both run kernel.admin.user.mfa.set.
  it("no second step: no Quitar segundo paso; every member, admin or not, has the requirement switch and the password reset", () => {
    const html = render(data);
    expect(text(html)).not.toContain("Quitar segundo paso");
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Exigir verificación en dos pasos"/);
    expect(html).toMatch(/<button[^>]*>Restablecer contraseña<\/button>/);
  });

  it("a set-up second step offers Quitar segundo paso", () => {
    const html = render({ ...data, member: { ...data.member, mfaEnrolled: true } });
    expect(html).toMatch(/<button[^>]*>Quitar segundo paso<\/button>/);
  });

  it("an admin gets the same switch, checked when an administrator requires their second step", () => {
    const admin = { ...data.member, roleIds: ["r-admin"], mfaEnrolled: true };
    const off = render({ ...data, member: admin });
    expect(off).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Exigir verificación en dos pasos"/);
    const on = render({ ...data, member: { ...admin, mfaRequired: true } });
    expect(on).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="true"[^>]*aria-label="Exigir verificación en dos pasos"/);
    expect(text(on)).toContain("exigida");
  });
});
