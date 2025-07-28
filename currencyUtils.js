// currencyUtils.js
// Helper for fetching the active currency
import Currency from './models/Currency.js';

/**
 * Returns the active currency (symbol, code, etc) or defaults to USD/$ if not set.
 * @returns {Promise<{symbol: string, code: string, name?: string, rate?: number}>}
 */
export async function getActiveCurrency() {
    const currency = await Currency.findOne({ isActive: true });
    if (currency) return currency;
    return { symbol: '$', code: 'USD', name: 'US Dollar', rate: 1 };
}
