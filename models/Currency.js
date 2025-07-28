import mongoose from 'mongoose';

const currencySchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true }, // e.g. USD, EUR
  symbol: { type: String, required: true }, // e.g. $, €
  name: { type: String, required: true }, // e.g. US Dollar
  isActive: { type: Boolean, default: true },
  rate: { type: Number, default: 1 }, // relative to base currency
}, {
  timestamps: true
});

export default mongoose.model('Currency', currencySchema);
