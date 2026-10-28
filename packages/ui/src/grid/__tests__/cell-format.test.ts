import { describe, expect, it } from "vitest";
import { formatCellValue, isEmptyCell } from "../cell-format";

// How a value shows in a grid cell and in the assistant's result table (one formatter, so they cannot drift): money
// `$ 1.234.567,00`, dates in the company's time zone, Sí / No, and the grid's conventions for nothing (null, "" and a
// zero amount show as a dash).

const text = { yes: "Sí", no: "No" };

describe("formatCellValue", () => {
  it("money as $ 1.234.567,00 from a number or the numeric string the database gives", () => {
    expect(formatCellValue({ type: "money" }, 1234567, text)).toBe("$ 1.234.567,00");
    expect(formatCellValue({ type: "money" }, "1234567.0000", text)).toBe("$ 1.234.567,00");
  });

  it("a date and time in the company's time zone, not the browser's or UTC", () => {
    // 03:30 UTC on the 28th is 22:30 on the 27th in Bogotá (UTC-5) and 12:30 on the 28th in Tokyo (UTC+9).
    expect(formatCellValue({ type: "datetime" }, "2026-10-28T03:30:00Z", { ...text, timeZone: "America/Bogota" })).toMatch(/^27\/10\/26.*10:30\s?p\.\s?m\.$/);
    expect(formatCellValue({ type: "datetime" }, "2026-10-28T03:30:00Z", { ...text, timeZone: "Asia/Tokyo" })).toMatch(/^28\/10\/26.*12:30\s?p\.\s?m\.$/);
  });

  it("a date without time is the same day in every zone", () => {
    for (const timeZone of ["America/Bogota", "Asia/Tokyo", "UTC"]) expect(formatCellValue({ type: "date" }, "2026-10-27", { ...text, timeZone })).toBe("27/10/26");
  });

  it("Sí / No, option labels (also in lists), JSON and plain text", () => {
    expect(formatCellValue({ type: "boolean" }, true, text)).toBe("Sí");
    expect(formatCellValue({ type: "boolean" }, false, text)).toBe("No");
    const options = [{ value: "customer", label: "Cliente" }];
    expect(formatCellValue({ type: "enum", options }, "customer", text)).toBe("Cliente");
    expect(formatCellValue({ type: "enum", options }, ["customer", "x"], text)).toBe("Cliente, x");
    expect(formatCellValue({ type: "json" }, { a: 1 }, text)).toBe('{"a":1}');
    expect(formatCellValue({ type: "text" }, "Café", text)).toBe("Café");
  });
});

describe("isEmptyCell (null, empty text and a zero amount show as a dash)", () => {
  it("follows the grid's convention", () => {
    expect(isEmptyCell({ type: "text" }, null)).toBe(true);
    expect(isEmptyCell({ type: "text" }, "")).toBe(true);
    expect(isEmptyCell({ type: "money" }, 0)).toBe(true);
    expect(isEmptyCell({ type: "money" }, "0.0000")).toBe(true);
    expect(isEmptyCell({ type: "number" }, 0)).toBe(false);
    expect(isEmptyCell({ type: "boolean" }, false)).toBe(false);
    expect(isEmptyCell({ type: "money" }, 5)).toBe(false);
  });
});
