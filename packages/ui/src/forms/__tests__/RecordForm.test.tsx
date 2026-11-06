// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortal } from "react-dom";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { FormActions, RecordForm } from "../form-parts";
import { RecordBridgeProvider, type RecordBridge } from "../../record/record-bridge";
import type { SaveFlow } from "../use-save";

afterEach(cleanup);

// Branch review fix 4: React events bubble through portals, so a dialog opened from a form (the supplier lookup's
// advanced filter) would hand its Ctrl+S to the form behind it. The form saves only for keys typed in its own fields.
describe("RecordForm", () => {
  it("saves on Ctrl+S from its own fields, never from a dialog portalled out of it", () => {
    const onSave = vi.fn();
    renderEs(
      <RecordForm canSave onSave={onSave} failure={null}>
        <input aria-label="propio" />
        {createPortal(<input aria-label="en el diálogo" />, document.body)}
      </RecordForm>,
    );
    fireEvent.keyDown(screen.getByLabelText("en el diálogo"), { key: "s", ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText("en el diálogo"), { key: "Enter", metaKey: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("propio"), { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

// Owner 2026-11-05: inside a record frame «Descartar cambios» moves to the frame's header (next to «Cambios sin guardar»), so the form
// hands its discard to the bridge and its own footer no longer shows it; the "Ver códigos DIAN" switch is gone (codes always show).
describe("RecordForm in a record frame (owner 2026-11-05)", () => {
  const flow = { failure: null, stepUp: false, saving: false, stepUpError: null, confirmStepUp: async () => {}, cancelStepUp: () => {}, submit: async () => null } as unknown as SaveFlow;

  it("hands its discard to the frame and leaves «Descartar cambios» out of its own footer", async () => {
    const onDiscard = vi.fn();
    let seen: RecordBridge | null = null;
    renderEs(
      <RecordBridgeProvider>
        {(bridge) => {
          seen = bridge;
          return (
            <RecordForm canSave onSave={() => {}} dirty save={async () => true} onDiscard={onDiscard} failure={null}>
              <input aria-label="campo" />
              <FormActions flow={flow} isNew={false} dirty blocked={false} pendingCount={0} onSave={() => {}} onDiscard={onDiscard} process="core.party.update" />
            </RecordForm>
          );
        }}
      </RecordBridgeProvider>,
    );
    await waitFor(() => expect(seen!.registered).toBe(true));
    expect(seen!.state.dirty).toBe(true);
    expect(seen!.canDiscard).toBe(true);
    expect(screen.queryByRole("button", { name: "Descartar cambios" })).toBeNull();
    act(() => seen!.discard());
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("outside a frame the footer keeps «Descartar cambios»", () => {
    renderEs(
      <RecordForm canSave onSave={() => {}} dirty failure={null}>
        <FormActions flow={flow} isNew={false} dirty blocked={false} pendingCount={0} onSave={() => {}} onDiscard={() => {}} process="core.party.update" />
      </RecordForm>,
    );
    expect(screen.getByRole("button", { name: "Descartar cambios" })).toBeTruthy();
  });

  it("has no «Ver códigos DIAN» switch", () => {
    renderEs(
      <RecordForm canSave onSave={() => {}} failure={null}>
        <input aria-label="campo" />
      </RecordForm>,
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Ver códigos DIAN")).toBeNull();
  });
});
