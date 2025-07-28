import mongoose from 'mongoose';

const OrderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  serviceName: { type: String },
  price: { type: Number },
  message: { type: String },
  details: { type: Object, default: {} },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'cancelled'], default: 'pending' },
  payment: {
    method: { type: String, default: '' },
    status: { type: String, enum: ['unpaid', 'paid', 'failed'], default: 'unpaid' },
    paymentLink: { type: String, default: '' }
  },
  adminReplies: [{
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    isCustomer: { type: Boolean, default: false }
  }]
}, { timestamps: true });

const Order = mongoose.model('Order', OrderSchema);
export default Order;
