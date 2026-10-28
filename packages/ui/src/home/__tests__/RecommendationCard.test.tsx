// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { RecommendationCard, type RecommendationItem } from "../RecommendationCard";

afterEach(cleanup);

const base: RecommendationItem = {
  id: "r1",
  title: "Hay 3 terceros activos que no se pueden facturar",
  body: "Les faltan datos de la DIAN. Completarlos evita rechazos al facturar.",
  agentProfile: "ayuda",
  confidence: 0.82,
  suggestedActions: [
    { label: "Completar con el asistente", processId: "core.party.update", input: { id: "p1" } },
    { label: "Ver terceros", href: "/parties" },
  ],
};

describe("RecommendationCard", () => {
  it("renders the title, the explanation and one button per suggested action, plus Descartar", () => {
    renderEs(<RecommendationCard recommendation={base} onAction={vi.fn()} onLink={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText(base.title)).toBeTruthy();
    expect(screen.getByText(base.body)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Completar con el asistente" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ver terceros" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeTruthy();
  });

  it("calls onAction(processId, input, index) for a process action and never runs anything itself", () => {
    const onAction = vi.fn();
    renderEs(<RecommendationCard recommendation={base} onAction={onAction} onLink={vi.fn()} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Completar con el asistente" }));
    expect(onAction).toHaveBeenCalledWith("core.party.update", { id: "p1" }, 0);
  });

  it("calls onLink(href, index) for a link action and onDismiss for Descartar", () => {
    const onLink = vi.fn();
    const onDismiss = vi.fn();
    renderEs(<RecommendationCard recommendation={base} onAction={vi.fn()} onLink={onLink} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver terceros" }));
    expect(onLink).toHaveBeenCalledWith("/parties", 1);
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onDismiss).toHaveBeenCalledWith("r1");
  });

  it("disables its buttons while the decision is being saved", () => {
    renderEs(<RecommendationCard recommendation={base} busy onAction={vi.fn()} onLink={vi.fn()} onDismiss={vi.fn()} />);
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("a recommendation with no action still can be dismissed", () => {
    renderEs(<RecommendationCard recommendation={{ ...base, suggestedActions: [] }} onAction={vi.fn()} onLink={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Descartar"]);
  });
});
