export interface SparklineProps {
  /** Oldest to newest; fewer than two draws nothing. */
  values: readonly number[];
  /** Accessible name (the trend in words: from the first to the last value). */
  label: string;
  /** Height in viewBox units; the SVG fills its box. */
  height?: number;
}

/** Two decimals, no trailing zeros: `0`, `9.23`, `120`. */
const coord = (n: number) => String(Number(n.toFixed(2)));

/**
 * A trend line drawn to scale in the card's width (UI density audit §2.27, OD-9): a 120-unit-wide box stretched to the
 * card (`preserveAspectRatio="none"`) with a 1.5 px stroke that does not stretch, the area in `--accent`, the line in
 * `--primary`. The smallest value sits 2 units above the floor, the largest 2 below the top, so the line is never clipped.
 */
export function Sparkline({ values, label, height = 28 }: SparklineProps) {
  if (values.length < 2) return null;
  const width = 120;
  const pad = 2;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const x = (i: number) => coord((i * width) / (values.length - 1));
  const y = (v: number) => coord(height - pad - ((v - min) / span) * (height - 2 * pad));
  const line = values.map((v, i) => `${x(i)},${y(v)}`).join(" L");
  return (
    <svg className="erp-home-kpi__trend" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={`M0,${height} L${line} L${width},${height} Z`} fill="var(--accent)" />
      <path d={`M${line}`} fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
