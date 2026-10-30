import { describe, expect, it } from "vitest";
import { addGrant, removeGrant, securityInput, securityTabVisible, setGrant, stepUpFor, type Grant } from "../account-security-model";

const contador: Grant = { subjectKind: "role", subjectId: "r-1", subjectName: "contador", canView: true, canPost: false };

describe("account-security model", () => {
  it("security tab: a grant with contabilizar implies ver; Quitar asks for step-up; a non-admin sees no Seguridad tab", () => {
    // contabilizar implies ver; taking ver away takes contabilizar with it.
    const posted = setGrant([{ ...contador, canView: false }], "role", "r-1", { canPost: true });
    expect(posted[0]).toMatchObject({ canView: true, canPost: true });
    expect(setGrant(posted, "role", "r-1", { canView: false })[0]).toMatchObject({ canView: false, canPost: false });

    // Agregar starts with ver, once per subject.
    const added = addGrant([], { kind: "user", id: "u-1", name: "Marcela" });
    expect(added).toEqual([{ subjectKind: "user", subjectId: "u-1", subjectName: "Marcela", canView: true, canPost: false }]);
    expect(addGrant(added, { kind: "user", id: "u-1", name: "Marcela" })).toHaveLength(1);

    // Quitar leaves the other grants and is a change of the step-up process: the save is the same process as any other change.
    const left = removeGrant([contador, ...added], "role", "r-1");
    expect(left.map((g) => g.subjectId)).toEqual(["u-1"]);
    expect(securityInput("a-1", { access: "restricted", grants: left })).toEqual({
      accountId: "a-1",
      access: "restricted",
      grants: [{ subjectKind: "user", subjectId: "u-1", canView: true, canPost: false }],
    });
    expect(stepUpFor("remove")).toEqual({ process: "accounting.account_permission.update", stepUp: true });
    expect(stepUpFor("add").stepUp && stepUpFor("access").stepUp && stepUpFor("toggle").stepUp).toBe(true);

    // Only the admin reads the permissions: no consult answer, no tab.
    expect(securityTabVisible(null)).toBe(false);
    expect(securityTabVisible({ access: "open" })).toBe(true);
  });
});
