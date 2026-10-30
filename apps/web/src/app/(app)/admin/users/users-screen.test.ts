import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { messages } from "@erp/i18n";
import type { AdminMember, UsersData } from "@/lib/admin/load";
import { UsersScreen } from "./users-screen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/users" }));
vi.mock("@/lib/admin/actions", () => ({ adminAction: vi.fn() }));

// Usuarios' 2FA column (design §22.19): "activo" with a factor, "pendiente" without one, and "exenta" for a user the admin
// exempted from the admin role's requirement who has no factor (nothing is pending for them).

const member = (name: string, mfaEnrolled: boolean, mfaExempt: boolean): AdminMember => ({
  userId: `019a2c4e-0000-7000-8000-0000000000${name.length.toString(16).padStart(2, "0")}`,
  name,
  email: `${name.toLowerCase()}@demo.local`,
  mobileCc: "57",
  mobile: "3165550123",
  photo: null,
  roleIds: ["r-admin"],
  mfaEnrolled,
  mfaExempt,
  locale: "es-419",
  isActive: true,
});
const data: UsersData = {
  roles: [{ id: "r-admin", name: "admin", description: "", partyScope: "ambos", isSystemAdmin: true }],
  members: [member("Ana", true, false), member("Bruno", false, false), member("Carla", false, true), member("Dario", true, true)],
};

const render = () =>
  renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "es-419", messages: messages("es-419"), timeZone: "America/Bogota" } as ComponentProps<typeof NextIntlClientProvider>, createElement(UsersScreen, { data })));

describe("UsersScreen 2FA column", () => {
  it("reads activo, pendiente or exenta", () => {
    const rows = render().split("<tr>").slice(2);
    const pill = (row: string) => row.match(/<td><span class="erp-pill erp-pill--(\w+)">([^<]+)<\/span><\/td><td><span class="erp-pill erp-pill--(?:ok|gray)">Activo/)?.slice(1, 3);
    expect(rows.map(pill)).toEqual([
      ["ok", "activo"],
      ["warn", "pendiente"],
      ["info", "exenta"],
      ["ok", "activo"],
    ]);
  });
});
