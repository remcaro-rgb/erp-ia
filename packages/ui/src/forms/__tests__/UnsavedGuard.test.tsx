// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { RecordForm } from "../form-parts";
import { UnsavedProvider, useHasUnsaved, type UnsavedState } from "../unsaved-guard";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";

beforeAll(stubLayoutApis);
afterEach(cleanup);

// UX-OD-4 (T8): a record form with changes reports itself to the shell while mounted and says "Sin guardar"; a clean one does not.
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
  it("reports its changes with a save, and shows the words Sin guardar", () => {
    const report = vi.fn();
    form(true, report);
    const state = report.mock.calls.find(([, s]) => s !== null)?.[1] as UnsavedState;
    expect(state.dirty).toBe(true);
    expect(typeof state.save).toBe("function");
    expect(screen.getByText("Sin guardar")).toBeTruthy();
    expect(screen.getByTestId("probe").textContent).toBe("true");
  });

  it("a clean form reports nothing and shows no note; leaving it clears its report", () => {
    const report = vi.fn();
    const view = form(false, report);
    expect(report.mock.calls.every(([, s]) => s === null)).toBe(true);
    expect(screen.queryByText("Sin guardar")).toBeNull();
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
