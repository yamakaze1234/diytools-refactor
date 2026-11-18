export function overviewTableTotals(
  config: {overviewFeeRate?: number},
  costs: {erp: number | null; tax: number | null},
  quote: {priceCents: number | null; term: number | null; percent: number | null},
  overrides?: {price?: number; rate?: number},
): {rate: number; erp: number | null; tax: number | null; fee: number | null; interest: number | null; taxProfit: number | null; erpProfit: number | null};
