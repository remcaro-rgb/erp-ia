/** The fiscal year of Colombian companies is the calendar year. */
export function fiscalYearFor(date: string): { year: number; startsOn: string; endsOn: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || Number.isNaN(Date.parse(date))) throw new Error(`invalid date ${date}: use YYYY-MM-DD`);
  const year = Number(match[1]);
  return { year, startsOn: `${year}-01-01`, endsOn: `${year}-12-31` };
}
