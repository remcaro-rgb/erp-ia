import { describe, expect, it } from "vitest";
import type { AdminMember } from "@/lib/admin/load";
import { draftOf, userChanges } from "./user-changes";

// The "Editar" dialog of a user (design §22.16) sends kernel.admin.user.update only what the admin changed: the process
// refuses an empty change, a photo travels only when it was replaced or removed, and the roles are compared as a set.

const marcela: AdminMember = {
  userId: "019a2c4e-0000-7000-8000-0000000000aa",
  name: "Marcela Rojas",
  email: "marcela@demo.local",
  mobileCc: "57",
  mobile: "3165550123",
  photo: null,
  roleIds: ["r-cajero", "r-bodega"],
  mfaEnrolled: false,
  mfaRequired: false,
  locale: "es-419",
  isActive: true,
};

describe("userChanges", () => {
  it("answers null when nothing changed (the roles in another order are the same roles)", () => {
    expect(userChanges(marcela, draftOf(marcela))).toBeNull();
    expect(userChanges(marcela, { ...draftOf(marcela), roleIds: ["r-bodega", "r-cajero"], name: " Marcela Rojas " })).toBeNull();
  });

  it("sends the mobile with its country code when either changed", () => {
    expect(userChanges(marcela, { ...draftOf(marcela), mobile: "3001112233" })).toEqual({ userId: marcela.userId, mobileCc: "57", mobile: "3001112233" });
    expect(userChanges(marcela, { ...draftOf(marcela), mobileCc: "1" })).toEqual({ userId: marcela.userId, mobileCc: "1", mobile: "3165550123" });
  });

  it("sends the trimmed name, the locale, the roles and the photo (null removes it) only when they changed", () => {
    const photo = "data:image/png;base64,iVBORw0KGgo=";
    expect(userChanges(marcela, { ...draftOf(marcela), name: "  Marcela R.  ", locale: "en", roleIds: ["r-cajero"], photo })).toEqual({
      userId: marcela.userId,
      name: "Marcela R.",
      locale: "en",
      roleIds: ["r-cajero"],
      photo,
    });
    expect(userChanges({ ...marcela, photo }, { ...draftOf({ ...marcela, photo }), photo: null })).toEqual({ userId: marcela.userId, photo: null });
  });
});
