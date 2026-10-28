// @vitest-environment jsdom
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { messages, type Locale } from "@erp/i18n";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../ui/sheet";
import { stubLayoutApis } from "../../shell/__tests__/intl";

// Final review M2 (rule 24): the shadcn dialog and sheet name their close button from the catalogue (`common.close`),
// not with an English literal.

afterEach(cleanup);
stubLayoutApis();

const renderIn = (locale: Locale, ui: ReactElement) =>
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale={locale} messages={messages(locale)} timeZone="America/Bogota">
        {children}
      </NextIntlClientProvider>
    ),
  });

const dialog = (
  <Dialog open>
    <DialogContent>
      <DialogTitle>Título</DialogTitle>
      <DialogDescription>Descripción</DialogDescription>
      <DialogFooter showCloseButton />
    </DialogContent>
  </Dialog>
);
const sheet = (
  <Sheet open>
    <SheetContent>
      <SheetTitle>Título</SheetTitle>
      <SheetDescription>Descripción</SheetDescription>
    </SheetContent>
  </Sheet>
);

describe("close labels of the dialog and the sheet", () => {
  it("say Cerrar in es-419", () => {
    renderIn("es-419", dialog);
    // The corner X (screen-reader text) and the footer button.
    expect(screen.getAllByRole("button", { name: "Cerrar" })).toHaveLength(2);
    expect(screen.queryByText("Close")).toBeNull();
    cleanup();
    renderIn("es-419", sheet);
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeTruthy();
  });

  it("say Close in en", () => {
    renderIn("en", dialog);
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
    cleanup();
    renderIn("en", sheet);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});
