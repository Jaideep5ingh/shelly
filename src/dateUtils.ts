const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function dateForTimezone(timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Failed to build date for timezone ${timezone}`);
  }

  return `${year}-${month}-${day}`;
}

export function normalizeDateInput(dateInput: string): string {
  const match = DATE_PATTERN.exec(dateInput);
  if (!match) {
    throw new Error(`Invalid date '${dateInput}'. Expected format: YYYY-MM-DD`);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}
