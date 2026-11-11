// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { HelpWidget, KpisWidget, RecentWidget, RecommendationsWidget } from "../widgets";

afterEach(cleanup);

describe("KpisWidget", () => {
  it("draws one card per KPI, and says so when there are none", () => {
    const { unmount } = renderEs(
      <KpisWidget
        kpis={[
          { id: "core.products", label: "home.kpi.core_products.label", value: 25, unit: "count", detail: { key: "home.kpi.core_products.detail", params: { not_ready: 0 } } },
          { id: "support.tickets", label: "home.kpi.support_tickets.label", value: 2, unit: "count", tone: "warn", detail: { key: "home.kpi.support_tickets.detail", params: { total: 5 } } },
        ]}
      />,
    );
    expect(screen.getByText("Productos")).toBeTruthy();
    expect(screen.getByText("Todos listos para facturar")).toBeTruthy();
    expect(screen.getByText("abiertos · 5 en total")).toBeTruthy();
    unmount();
    renderEs(<KpisWidget kpis={[]} />);
    expect(screen.getByText("No hay indicadores para mostrar con tus permisos.")).toBeTruthy();
  });
});

describe("RecommendationsWidget", () => {
  const item = { id: "r1", title: "Activa la verificación en dos pasos", body: "Tu rol puede aprobar cambios sensibles.", agentProfile: "help", suggestedActions: [{ label: "Ver la guía", href: "/" }] };

  it("passes the recommendation's id with the chosen action and with Descartar", () => {
    const onLink = vi.fn();
    const onDismiss = vi.fn();
    renderEs(<RecommendationsWidget items={[item]} onAction={vi.fn()} onLink={onLink} onDismiss={onDismiss} />);
    expect(screen.getByText("Agente de ayuda")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver la guía" }));
    expect(onLink).toHaveBeenCalledWith("r1", "/", 0);
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onDismiss).toHaveBeenCalledWith("r1");
  });

  it("says when there is nothing pending and when a decision could not be saved", () => {
    renderEs(<RecommendationsWidget items={[]} error="failed" onAction={vi.fn()} onLink={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText("Sin recomendaciones pendientes")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("No se pudo guardar tu decisión. Inténtalo de nuevo.");
  });
});

describe("RecommendationsWidget refusal", () => {
  it("says the user may not do the suggested action, and keeps the card", () => {
    const item = { id: "r1", title: "Crea tu primer cliente", body: "Cuerpo", agentProfile: "seed", suggestedActions: [{ label: "Crear", processId: "core.party.create", input: {} }] };
    renderEs(<RecommendationsWidget items={[item]} error="refused" onAction={vi.fn()} onLink={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe("Tu rol no puede hacer esta acción, así que no la abrimos. Descarta la recomendación o consulta al administrador.");
    expect(screen.getByText("Crea tu primer cliente")).toBeTruthy();
  });
});

describe("RecentWidget", () => {
  const records = [
    { entity: "core.party", entityLabel: "entity.core.party", id: "p1", title: "Supermercados Éxito", action: "update" as const, at: "2026-10-28T15:30:00Z", href: "/r/core.party/p1" },
    { entity: "kernel.export_job", entityLabel: "entity.kernel.export_job", id: "j1", title: null, action: "insert" as const, at: "2026-10-28T10:00:00Z", href: null },
  ];

  it("lists the records with their kind, action and when, linking the ones that have a screen", () => {
    const onOpen = vi.fn();
    renderEs(<RecentWidget records={records} onOpen={onOpen} />);
    const link = screen.getByRole("link", { name: "Abrir Supermercados Éxito" });
    expect(link.getAttribute("href")).toBe("/r/core.party/p1");
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("/r/core.party/p1");
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getByText("Modificado")).toBeTruthy();
    expect(within(rows[1]!).getByText("Tercero")).toBeTruthy();
    expect(within(rows[2]!).getByText("Creado")).toBeTruthy();
    expect(within(rows[2]!).getByText("—")).toBeTruthy();
    expect(within(rows[2]!).queryByRole("link")).toBeNull();
  });

  it("says so when the user has touched nothing yet", () => {
    renderEs(<RecentWidget records={[]} onOpen={vi.fn()} />);
    expect(screen.getByText("Aún no has creado ni modificado registros.")).toBeTruthy();
  });
});

describe("HelpWidget", () => {
  it("asks the assistant the shortcut's question, in the user's language", () => {
    const onAsk = vi.fn();
    renderEs(<HelpWidget shortcuts={[{ id: "parties", labelKey: "home.help.parties.label", questionKey: "home.help.parties.question" }]} onAsk={onAsk} />);
    fireEvent.click(screen.getByRole("button", { name: "Crear o buscar un tercero" }));
    expect(onAsk).toHaveBeenCalledWith("¿Cómo creo un tercero?");
  });
});

describe("RecommendationsWidget states", () => {
  const props = { items: [], onAction: vi.fn(), onLink: vi.fn(), onDismiss: vi.fn() };

  it("explains an empty list, and tells loading and a failed read apart from it", () => {
    const { unmount } = renderEs(<RecommendationsWidget {...props} />);
    expect(screen.getByTestId("recommendations-empty").textContent).toContain("Cuando un agente encuentre algo");
    unmount();
    const loading = renderEs(<RecommendationsWidget {...props} status="loading" />);
    expect(screen.getByRole("status").textContent).toBe("Cargando recomendaciones…");
    expect(screen.queryByTestId("recommendations-empty")).toBeNull();
    loading.unmount();
    renderEs(<RecommendationsWidget {...props} status="unavailable" />);
    expect(screen.getByRole("alert").textContent).toContain("No se pudieron cargar las recomendaciones");
    expect(screen.queryByTestId("recommendations-empty")).toBeNull();
  });
});
