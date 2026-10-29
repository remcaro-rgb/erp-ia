import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import type { AiUsage } from "@erp/kernel";
import { messages } from "@erp/i18n";
import { AiUsageScreen } from "./ai-usage-screen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// Phase 1b task 1 (audit §2.32): the allowance bar is 12 px with ticks at 80 % and 100 %, writes the percentage, and an over-cap
// month says what that means in words instead of only turning red; the cost column has fixed decimals.

const base: AiUsage = {
  month: "2026-10",
  used: 1_912_400,
  limit: 2_500_000,
  costUsd: 12.5,
  users: [{ userId: "u1", name: "Laura Martínez", email: "laura@demo.local", calls: 12, tokens: 1_912_400, costUsd: 0.0123 }],
  models: [{ task: "chat", model: "anthropic/claude-opus-5.5", calls: 12, tokens: 1_912_400, costUsd: 12.5 }],
} as AiUsage;

const render = (usage: AiUsage) =>
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: "es-419", messages: messages("es-419"), timeZone: "America/Bogota" } as ComponentProps<typeof NextIntlClientProvider>, createElement(AiUsageScreen, { data: usage })),
  );
// Tags out, and every kind of space as a plain one (the separators depend on the ICU data of the machine).
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("AiUsageScreen allowance", () => {
  it("under the cap: a meter with 80 % and 100 % ticks and the percentage written", () => {
    const html = render(base);
    expect(html).toMatch(/role="meter"/);
    expect(html).toMatch(/aria-valuenow="76"/);
    expect((html.match(/erp-meter__tick/g) ?? []).length).toBe(2);
    expect(html).toMatch(/left:80%/);
    expect(html).toMatch(/left:100%/);
    expect(text(html)).toMatch(/76\s?%/);
    expect(text(html)).not.toContain("límite alcanzado");
    expect(html).not.toContain("erp-bar");
  });

  it("from 80 %: the share is a warning pill", () => {
    const html = render({ ...base, used: 2_100_000 });
    expect(html).toMatch(/erp-pill--warn[^>]*><b>84\s?%/);
  });

  it("over the cap: the state is written, not only coloured", () => {
    const html = render({ ...base, used: 2_600_000 });
    expect(html).toMatch(/aria-valuenow="100"/);
    expect(html).toContain("is-over");
    expect(text(html)).toMatch(/104\s?%/);
    expect(text(html)).toContain("límite alcanzado: el asistente solo responde consultas");
    expect(html).toMatch(/erp-pill--danger/);
  });

  it("without a cap there is no meter", () => {
    const html = render({ ...base, limit: null });
    expect(html).not.toMatch(/role="meter"/);
    expect(text(html)).toContain("sin tope configurado");
  });

  it("costs have fixed 4 decimals so the column aligns", () => {
    const html = text(render(base));
    expect(html).toMatch(/0[.,]0123/);
    expect(html).toMatch(/12[.,]5000/);
  });

  it("the percentage pill uses tabular figures", () => {
    expect(render({ ...base, used: 2_100_000 })).toMatch(/erp-pill erp-pill--warn erp-num/);
    expect(render({ ...base, used: 2_600_000 })).toMatch(/erp-pill erp-pill--danger erp-num/);
  });

  it("a cap of zero is over the cap, whatever was used", () => {
    const html = render({ ...base, limit: 0, used: 0 });
    expect(html).toContain("is-over");
    expect(html).toMatch(/erp-pill--danger/);
    expect(text(html)).toContain("límite alcanzado");
  });
});
