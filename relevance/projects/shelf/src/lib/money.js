/** Format an integer number of cents as a USD string. Not wired to routes yet. */
export function formatUsd(cents) {
  if (!Number.isInteger(cents)) throw new TypeError("formatUsd expects integer cents");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

export function parseUsd(text) {
  const match = String(text).trim().match(/^(-)?\$(\d+)\.(\d{2})$/);
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number(match[3]);
  return match[1] ? -cents : cents;
}
