import mongoose from 'mongoose';

const quickReplySchema = new mongoose.Schema({
  label: { type: String, required: true }, // e.g. 'Order Confirmation'
  message: { type: String, required: true }, // e.g. 'Thank you for your order!'
  isActive: { type: Boolean, default: true },
  order: { type: Number, default: 0 }, // for sorting
}, {
  timestamps: true
});

export default mongoose.model('QuickReply', quickReplySchema);
