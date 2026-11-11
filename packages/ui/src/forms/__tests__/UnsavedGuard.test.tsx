// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { RecordFrame } from "../../record/RecordFrame";
import { RecordForm } from "../form-parts";
import { UnsavedProvider, useHasUnsaved, type UnsavedState } from "../unsaved-guard";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";

beforeAll(stubLayoutApis);
afterEach(cleanup);

// UX-OD-4 (T8): a record form with changes reports itself to the shell while mounted and says "Cambios sin guardar"; a clean one does not.
function Probe() {
  return <span data-testid="probe">{String(useHasUnsaved())}</span>;
}
const form = (dirty: boolean, report = vi.fn()) =>
  renderEs(
    <UnsavedProvider value={{ report, hasUnsaved: dirty }}>
      <RecordForm canSave onSave={() => {}} dirty={dirty} save={async () => true} failure={null}>
        <Probe />
      </RecordForm>
    </UnsavedProvider>,
  );

describe("RecordForm unsaved changes", () => {
  it("reports its changes with a save, and shows the words Cambios sin guardar", () => {
    const report = vi.fn();
    form(true, report);
    const state = report.mock.calls.find(([, s]) => s !== null)?.[1] as UnsavedState;
    expect(state.dirty).toBe(true);
    expect(typeof state.save).toBe("function");
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();
    expect(screen.getByTestId("probe").textContent).toBe("true");
  });

  it("a clean form reports nothing and shows no note; leaving it clears its report", () => {
    const report = vi.fn();
    const view = form(false, report);
    expect(report.mock.calls.every(([, s]) => s === null)).toBe(true);
    expect(screen.queryByText("Cambios sin guardar")).toBeNull();
    view.unmount();
  });

  it("outside a shell nobody listens and nothing breaks", () => {
    renderEs(
      <RecordForm canSave onSave={() => {}} dirty failure={null}>
        <span>campo</span>
      </RecordForm>,
    );
    expect(screen.getByText("campo")).toBeTruthy();
  });
});

describe("RecordForm inside a record frame", () => {
  it("puts Cambios sin guardar in the header, next to the title", () => {
    renderEs(
      <RecordFrame title="Cuenta 111005 - Moneda nacional" tabs={[{ id: "datos", content: <RecordForm canSave onSave={() => {}} dirty failure={null}>x</RecordForm> }]} />,
    );
    const header = document.querySelector(".erp-record__header")!;
    expect(header.contains(screen.getByText("Cambios sin guardar"))).toBe(true);
    expect(header.querySelector("h2")!.nextElementSibling!.textContent).toContain("Cambios sin guardar");
  });
});
