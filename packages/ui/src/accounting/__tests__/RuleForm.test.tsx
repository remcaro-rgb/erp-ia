// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { RuleForm } from "../RuleForm";

beforeAll(stubLayoutApis);
afterEach(cleanup);

const props = { record: null, save: async () => ({ ok: true as const, id: "r-1" }), isDefault: true, isModified: false };

describe("RuleForm stale badge", () => {
  it("shows «Sin coincidencias en N días» when the rule is stale", () => {
    renderEs(<RuleForm {...props} stale staleDays={30} />);
    expect(screen.getByText("Sin coincidencias en 30 días")).toBeTruthy();
  });
  it("shows no badge otherwise", () => {
    renderEs(<RuleForm {...props} stale={false} staleDays={30} />);
    expect(screen.queryByText(/Sin coincidencias/)).toBeNull();
  });
});
