/**
 * Display-formatting helpers used in tool summaries.
 * None of these throw — they return "N/A" on bad input.
 */

export function formatCurrency(n: number): string {
  if (!isFinite(n)) return "N/A";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPercent(n: number, decimals = 2): string {
  if (!isFinite(n)) return "N/A";
  const pct = n * 100;
  const sign = pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct).toFixed(decimals)}%`;
}

export function formatNumber(n: number, decimals = 2): string {
  if (!isFinite(n)) return "N/A";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
