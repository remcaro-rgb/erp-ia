// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { NotifyDialog } from "../NotifyDialog";

beforeAll(stubLayoutApis);
afterEach(cleanup);

describe("NotifyDialog", () => {
  it("minor 3: a send the mail server refused (status failed) says so and stays open to retry; a sent one closes", async () => {
    const onClose = vi.fn();
    const onSent = vi.fn();
    const onSend = vi.fn(async () => ({ ok: true as const, status: "failed" }));
    renderEs(<NotifyDialog open onClose={onClose} name="CE-1" recipients={["a@b.co"]} subject="CE-1" onSend={onSend} onSent={onSent} />);
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/No se pudo enviar/);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    onSend.mockImplementation(async () => ({ ok: true as const, status: "sent" }));
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(1));
    expect(onClose).toHaveBeenCalled();
  });
});
