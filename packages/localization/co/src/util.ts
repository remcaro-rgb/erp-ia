/** Trims a string; empty or undefined becomes undefined. */
export const clean = (s: string | undefined): string | undefined => {
  const v = s?.trim();
  return v ? v : undefined;
};
