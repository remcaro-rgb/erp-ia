import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry, type ProcessErrorCode } from "@erp/kernel";
import { core } from "@erp/module-core";
import { collectRegistryKeys, defaultLocale, locales, messages, type Messages } from "../index";

/** Every leaf of a nested catalogue as `a.b.c`, sorted. */
function leaves(tree: Messages, prefix = ""): string[] {
  return Object.entries(tree)
    .flatMap(([key, value]) => (typeof value === "string" ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`)))
    .sort();
}

function valueAt(tree: Messages, key: string): string | undefined {
  let node: Messages | string | undefined = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** ICU arguments a message uses: `{name}` and `{count, plural, ...}` both give the name. */
const argumentsOf = (text: string): string[] => [...new Set([...text.matchAll(/\{\s*([a-z_][a-z0-9_]*)\s*[,}]/g)].map((m) => m[1]!))].sort();

const registry = new Registry();
loadModules(registry, [kernelModule, core]);

const es = messages("es-419");
const en = messages("en");

describe("locales", () => {
  it("offers es-419 first and defaults to it", () => {
    expect(locales).toEqual(["es-419", "en"]);
    expect(defaultLocale).toBe("es-419");
  });

  it("has the namespaces of the design in every catalogue", () => {
    const namespaces = ["agent", "auth", "common", "entity", "errors", "feature", "field", "grid", "nav", "process"];
    expect(Object.keys(es).sort()).toEqual(namespaces);
    expect(Object.keys(en).sort()).toEqual(namespaces);
  });
});

describe("catalogue shape", () => {
  it("en has exactly the keys of es-419", () => {
    expect(leaves(en)).toEqual(leaves(es));
  });

  it("no value is empty, in either locale", () => {
    for (const [name, tree] of [["es-419", es], ["en", en]] as const) {
      const empty = leaves(tree).filter((key) => (valueAt(tree, key) ?? "").trim() === "");
      expect(empty, `${name} has empty values`).toEqual([]);
    }
  });

  it("every key is lowercase snake_case segments joined by dots", () => {
    const bad = leaves(es).filter((key) => !/^[a-z0-9_.]+$/.test(key) || key.split(".").some((part) => part === ""));
    expect(bad).toEqual([]);
  });

  it("a message uses the same arguments in both locales", () => {
    const mismatched = leaves(es).filter((key) => argumentsOf(valueAt(es, key)!).join() !== argumentsOf(valueAt(en, key)!).join());
    expect(mismatched).toEqual([]);
  });
});

describe("registry labels", () => {
  const keys = collectRegistryKeys(registry);

  it("collects the entity, field, navigation and feature labels of the loaded modules", () => {
    expect(keys).toContain("entity.core.party");
    expect(keys).toContain("field.core.party.legal_name");
    expect(keys).toContain("nav.core.parties");
    expect(keys).toContain("feature.kernel.attachments");
    expect(keys.filter((key) => key.startsWith("entity.")).length).toBe(registry.entities().length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every registered label key exists in es-419 and en", () => {
    expect(keys.filter((key) => valueAt(es, key) === undefined)).toEqual([]);
    expect(keys.filter((key) => valueAt(en, key) === undefined)).toEqual([]);
  });

  it("every registered label key lives in its own namespace", () => {
    for (const key of keys) expect(["entity", "field", "nav", "feature"]).toContain(key.split(".")[0]);
  });
});

describe("process errors", () => {
  const codes: Record<ProcessErrorCode, true> = {
    not_entitled: true,
    forbidden: true,
    step_up_required: true,
    invalid_input: true,
    not_found: true,
    handler_failed: true,
    idempotent_replay: true,
  };

  it("every ProcessError code has an errors.<code> message in both locales", () => {
    for (const code of Object.keys(codes)) {
      expect(valueAt(es, `errors.${code}`), `es-419 errors.${code}`).toBeTruthy();
      expect(valueAt(en, `errors.${code}`), `en errors.${code}`).toBeTruthy();
    }
  });
});
