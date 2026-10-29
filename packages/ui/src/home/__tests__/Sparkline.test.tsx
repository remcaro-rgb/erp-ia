// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { Sparkline } from "../Sparkline";

afterEach(cleanup);

// The audit's example (UI density audit §2.27): 14 daily points, minimum 3, maximum 14.
const SERIES = [3, 5, 4, 6, 8, 7, 9, 6, 10, 12, 11, 9, 13, 14];
const LINE = "M0,26 L9.23,21.64 L18.46,23.82 L27.69,19.45 L36.92,15.09 L46.15,17.27 L55.38,12.91 L64.62,19.45 L73.85,10.73 L83.08,6.36 L92.31,8.55 L101.54,12.91 L110.77,4.18 L120,2";

describe("Sparkline", () => {
  it("draws the 14 points to scale in a 120 x 28 box: the minimum at y 26, the maximum at y 2", () => {
    renderEs(<Sparkline values={SERIES} label="Tendencia" />);
    const svg = screen.getByRole("img", { name: "Tendencia" });
    expect(svg.getAttribute("viewBox")).toBe("0 0 120 28");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
    const [area, line] = [...svg.querySelectorAll("path")];
    expect(line!.getAttribute("d")).toBe(LINE);
    expect(area!.getAttribute("d")).toBe(`M0,28 L${LINE.slice(1)} L120,28 Z`);
    expect(line!.getAttribute("stroke")).toBe("var(--primary)");
    expect(line!.getAttribute("stroke-width")).toBe("1.5");
    expect(line!.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(area!.getAttribute("fill")).toBe("var(--accent)");
  });

  it("a flat series is a flat line, not a division by zero", () => {
    renderEs(<Sparkline values={[5, 5, 5]} label="Plana" />);
    const d = screen.getByRole("img").querySelectorAll("path")[1]!.getAttribute("d")!;
    expect(d).not.toMatch(/NaN|Infinity/);
  });

  it("draws nothing for fewer than two points", () => {
    const { container } = renderEs(<Sparkline values={[4]} label="x" />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
