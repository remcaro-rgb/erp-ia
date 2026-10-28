import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { messages } from "@erp/i18n";

/** Renders `ui` with the es-419 catalogue, as the app does. */
export function renderEs(ui: ReactElement) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NextIntlClientProvider locale="es-419" messages={messages("es-419")} timeZone="America/Bogota">
      {children}
    </NextIntlClientProvider>
  );
  return render(ui, { wrapper });
}

/** cmdk scrolls the selected item into view, Radix measures; jsdom has neither. */
export function stubLayoutApis(): void {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
