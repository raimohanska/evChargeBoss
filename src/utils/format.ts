/** Format a euro amount with 3 decimal places, e.g. "0.025 EUR". */
export const formatEur = (eur: number): string => `${eur.toFixed(3)} EUR`;

/** Format a euro-cent amount with 2 decimal places, e.g. "2.50 cent". */
export const formatCents = (cents: number): string => `${cents.toFixed(2)} cent`;
