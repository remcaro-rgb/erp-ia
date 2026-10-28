// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MoneyInput } from "../MoneyInput";

/** A controlled input, as a form holds it. */
function Controlled({ initial, onChange }: { initial: number | null; onChange: (value: number | null) => void }) {
  const [value, setValue] = useState(initial);
  return <MoneyInput aria-label="Cupo" value={value} onChange={(v) => (setValue(v), onChange(v))} />;
}

afterEach(cleanup);

describe("MoneyInput", () => {
  it("shows the formatted amount, raw digits while focused, and reports the number on blur", () => {
    const onChange = vi.fn();
    render(<Controlled initial={1234567} onChange={onChange} />);
    const input = screen.getByLabelText("Cupo") as HTMLInputElement;
    expect(input.value).toBe("$ 1.234.567,00");
    expect(input.className).toMatch(/text-right/);
    expect(input.className).toMatch(/tabular-nums/);
    fireEvent.focus(input);
    expect(input.value).toBe("1234567");
    fireEvent.change(input, { target: { value: "2500000,5" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(2500000.5);
    expect(input.value).toBe("$ 2.500.000,50");
  });

  it("an emptied field reports null; a disabled one cannot be edited", () => {
    const onChange = vi.fn();
    const { rerender } = render(<MoneyInput aria-label="Cupo" value={10} onChange={onChange} />);
    const input = screen.getByLabelText("Cupo") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(null);
    rerender(<MoneyInput aria-label="Cupo" value={10} onChange={onChange} disabled />);
    expect(input.disabled).toBe(true);
  });
});
