// formatPrice.js
// Helper to format prices with currency symbol and 2 decimal places

export default function formatPrice(price, currency) {
  if (!currency || !currency.symbol) return `$${Number(price).toFixed(2)}`;
  return `${currency.symbol}${Number(price).toFixed(2)}`;
}
