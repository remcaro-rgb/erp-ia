// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { VersionsTab } from "../VersionsTab";

afterEach(cleanup);

const M = "••••••••";
const snap = (version: number, status: string, header: Record<string, string>) => ({ version, status, at: "2026-10-28T15:00:00Z", by: "Laura Mendoza", reason: null, header, lines: [] });

describe("VersionsTab (D18)", () => {
  it("compares the last two versions; a masked field shows masked in both and is never marked changed", () => {
    renderEs(
      <VersionsTab
        snapshots={[snap(1, "saved", { description: "Pago", account: M }), snap(2, "pending", { description: "Pago proveedor", account: M })]}
        labels={{ header: { description: "Descripción", account: "Cuenta destino" }, lines: {} }}
        masked={M}
      />,
    );
    expect(screen.getByText("Comparar v1 con v2")).toBeTruthy();
    // Estado and Descripción changed; the masked Cuenta destino is not counted.
    expect(screen.getByText("2 campos cambiados")).toBeTruthy();
    const masked = screen.getAllByText(M);
    expect(masked).toHaveLength(2);
    for (const cell of masked) expect(cell.getAttribute("data-changed")).toBeNull();
  });

  it("says when there are no versions yet", () => {
    renderEs(<VersionsTab snapshots={[]} labels={{ header: {}, lines: {} }} />);
    expect(screen.getByText(/Aún no hay versiones/)).toBeTruthy();
  });
});
