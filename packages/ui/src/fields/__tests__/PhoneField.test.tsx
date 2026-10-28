// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { EmailField, PhoneField, VerifyBadge } from "../../index";

afterEach(cleanup);

function Phone({ cc = "57", number = "", onChange = () => {}, ...rest }: { cc?: string; number?: string; onChange?: (v: { cc: string; number: string }) => void } & Partial<Parameters<typeof PhoneField>[0]>) {
  const [value, setValue] = useState({ cc, number });
  return (
    <PhoneField
      label="Teléfono principal"
      {...value}
      {...rest}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const type = (value: string) => fireEvent.change(screen.getByLabelText("Teléfono principal"), { target: { value } });

describe("PhoneField", () => {
  it("offers the country codes of the design and starts on +57", () => {
    render(<Phone />);
    const select = screen.getByLabelText("Indicativo del país") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["57", "1", "52", "593", "51", "507", "34", "56"]);
    expect(select.value).toBe("57");
    expect(screen.getByText("Celular 3… o fijo 60… (10 dígitos)")).toBeTruthy();
  });

  it("validates inline: +57 takes 10 digits starting with 3 or 60, or 7; other codes 6 to 14 digits", () => {
    render(<Phone />);
    type("12345");
    expect(screen.getByRole("alert").textContent).toBe("Colombia: celular 10 dígitos (3…) o fijo 10 dígitos (60…)");
    type("3001234567");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("✓ formato válido")).toBeTruthy();
    type("6015550000");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Indicativo del país"), { target: { value: "1" } });
    expect(screen.queryByRole("alert")).toBeNull();
    type("12345");
    expect(screen.getByRole("alert").textContent).toBe("6 a 14 dígitos");
    type("2025550123");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("✓ formato válido")).toBeTruthy();
    type("");
    expect(screen.getByText("Sin indicativo, solo dígitos")).toBeTruthy();
  });

  it("keeps digits only and reports the code and the number to the parent", () => {
    const onChange = vi.fn();
    render(<Phone onChange={onChange} />);
    type("300 123-4567");
    expect(onChange).toHaveBeenLastCalledWith({ cc: "57", number: "3001234567" });
    expect((screen.getByLabelText("Teléfono principal") as HTMLInputElement).value).toBe("3001234567");
    fireEvent.change(screen.getByLabelText("Indicativo del país"), { target: { value: "52" } });
    expect(onChange).toHaveBeenLastCalledWith({ cc: "52", number: "3001234567" });
  });

  it("an empty number is not an error", () => {
    render(<Phone />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows Verificar only for a valid number and passes the formatted phone", () => {
    const onVerify = vi.fn();
    render(<Phone verify={{ onVerify }} />);
    expect(screen.queryByRole("button", { name: /Verificar/ })).toBeNull();
    type("3001234567");
    fireEvent.click(screen.getByRole("button", { name: /Verificar/ }));
    expect(onVerify).toHaveBeenCalledWith("+573001234567");
  });

  it("is read-only when disabled", () => {
    render(<Phone number="3001234567" disabled />);
    expect((screen.getByLabelText("Teléfono principal") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Indicativo del país") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("EmailField", () => {
  function Email({ initial = "", ...rest }: { initial?: string } & Partial<Parameters<typeof EmailField>[0]>) {
    const [value, setValue] = useState(initial);
    return <EmailField label="Correo" value={value} onChange={setValue} {...rest} />;
  }

  it("validates inline and offers Verificar once the format is valid", () => {
    const onVerify = vi.fn();
    render(<Email verify={{ onVerify }} />);
    const input = screen.getByLabelText("Correo");
    fireEvent.change(input, { target: { value: "ana@" } });
    expect(screen.getByRole("alert").textContent).toBe("Correo inválido (nombre@dominio.ext)");
    expect(screen.queryByRole("button", { name: /Verificar/ })).toBeNull();
    fireEvent.change(input, { target: { value: " ana@exito.com " } });
    expect((input as HTMLInputElement).value).toBe("ana@exito.com");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Verificar/ }));
    expect(onVerify).toHaveBeenCalledWith("ana@exito.com");
  });

  it("flags an empty required e-mail", () => {
    render(<Email required />);
    expect(screen.getByRole("alert").textContent).toBe("Requerido");
  });
});

describe("VerifyBadge", () => {
  it("shows the queued, verified and failed states next to the button", () => {
    const { rerender } = render(<VerifyBadge kind="email" value="a@b.co" onVerify={() => {}} />);
    expect(screen.getByRole("button", { name: "Verificar ↗" })).toBeTruthy();
    rerender(<VerifyBadge kind="email" value="a@b.co" status="queued" onVerify={() => {}} />);
    expect(screen.getByText("en cola")).toBeTruthy();
    rerender(<VerifyBadge kind="email" value="a@b.co" status="verified" provider="ZeroBounce" onVerify={() => {}} />);
    expect(screen.getByText("verificado · ZeroBounce")).toBeTruthy();
    rerender(<VerifyBadge kind="email" value="a@b.co" status="failed" onVerify={() => {}} />);
    expect(screen.getByText("no verificado")).toBeTruthy();
  });

  it("does not verify an empty value", () => {
    const onVerify = vi.fn();
    render(<VerifyBadge kind="phone" value="" onVerify={onVerify} />);
    const button = screen.getByRole("button", { name: "Verificar ↗" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
