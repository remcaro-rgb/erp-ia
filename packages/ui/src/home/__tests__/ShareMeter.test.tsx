// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { ShareMeter } from "../ShareMeter";
import { renderEs } from "../../shell/__tests__/intl";

afterEach(cleanup);

describe("ShareMeter", () => {
  it("draws a 12 px meter with 80 % and 100 % ticks and the share as its value", () => {
    renderEs(<ShareMeter value={0.765} label="Uso del tope mensual" />);
    const meter = screen.getByRole("meter", { name: "Uso del tope mensual" });
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("100");
    expect(meter.getAttribute("aria-valuenow")).toBe("77");
    const ticks = [...meter.querySelectorAll<HTMLElement>(".erp-meter__tick")];
    expect(ticks.map((t) => t.style.left)).toEqual(["80%", "100%"]);
    expect(meter.querySelector<HTMLElement>(".erp-meter__fill")!.style.width).toBe("76.5%");
    expect(meter.classList.contains("is-over")).toBe(false);
    expect(meter.classList.contains("is-warn")).toBe(false);
  });

  it("marks the warning share (from 80 %) and the over-cap state, never wider than the track", () => {
    renderEs(<ShareMeter value={0.85} label="a" />);
    expect(screen.getByRole("meter").classList.contains("is-warn")).toBe(true);
    cleanup();
    renderEs(<ShareMeter value={1.4} label="b" />);
    const meter = screen.getByRole("meter");
    expect(meter.classList.contains("is-over")).toBe(true);
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect(meter.querySelector<HTMLElement>(".erp-meter__fill")!.style.width).toBe("100%");
  });

  it("copes with nothing used and with a nonsense share", () => {
    renderEs(<ShareMeter value={0} label="c" />);
    expect(screen.getByRole("meter").querySelector<HTMLElement>(".erp-meter__fill")!.style.width).toBe("0%");
    cleanup();
    renderEs(<ShareMeter value={Number.NaN} label="d" />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("0");
  });
});
