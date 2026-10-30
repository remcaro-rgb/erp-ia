import { describe, expect, it } from "vitest";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import { consultProcessesOf, entitlementKeyOf } from "../../query/access";
import { refLabelKey } from "../../query";
import { Registry } from "../../registry";

// The users of the company as an entity (design §22.15, rule 21): `kernel.user` is a kernel entity over `kernel.v_users`
// (migration 0026), named by the person's full name, with its own consult process, so a reference to a user (an audit
// actor, a ticket's reporter) resolves its label and its link like any other record's.

describe("kernel.user entity", () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule]);

  it("is registered by the kernel over kernel.v_users, named by full_name, with the mobile confidential and the member's state", () => {
    const user = registry.entity("kernel.user");
    expect(user.module).toBe("kernel");
    expect(`${user.schema}.v_${user.table}`).toBe("kernel.v_users");
    expect(user.displayField).toBe("full_name");
    expect(user.fields.map((f) => f.name)).toEqual(["full_name", "email", "locale", "mobile", "created_at", "is_active", "mfa_exempt"]);
    expect(user.fields.find((f) => f.name === "is_active")?.type).toBe("boolean");
    expect(user.fields.find((f) => f.name === "mfa_exempt")).toMatchObject({ type: "boolean", label: "field.kernel.user.mfa_exempt", sensitivity: "confidential" });
    expect(user.fields.find((f) => f.name === "mobile")?.sensitivity).toBe("confidential");
    expect(user.fields.filter((f) => f.searchable).map((f) => f.name)).toEqual(["full_name", "email"]);
  });

  it("is read through kernel.user.consult, a kernel consult of its own feature that needs no entitlement", () => {
    const user = registry.entity("kernel.user");
    expect(consultProcessesOf(registry, user)).toEqual(["kernel.user.consult"]);
    const consult = registry.process("kernel.user.consult");
    expect(consult.kind).toBe("consult");
    expect(consult.feature).toBe("kernel.users");
    expect(entitlementKeyOf(registry, user)).toBeNull();
    const feature = registry.module("kernel").features.find((f) => f.id === "kernel.users");
    expect(feature?.entities).toEqual(["kernel.user"]);
    expect(feature?.processes).toEqual(["kernel.user.consult", "kernel.user.mfa.disable"]);
  });

  it("names the label column of a reference after its field", () => {
    expect(refLabelKey("supplier_id")).toBe("supplier_id_label");
  });
});
