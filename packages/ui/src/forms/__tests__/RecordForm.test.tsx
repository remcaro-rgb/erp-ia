// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortal } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecordForm } from "../form-parts";

afterEach(cleanup);

// Branch review fix 4: React events bubble through portals, so a dialog opened from a form (the supplier lookup's
// advanced filter) would hand its Ctrl+S to the form behind it. The form saves only for keys typed in its own fields.
describe("RecordForm", () => {
  it("saves on Ctrl+S from its own fields, never from a dialog portalled out of it", () => {
    const onSave = vi.fn();
    render(
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
