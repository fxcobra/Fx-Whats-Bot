import mongoose from 'mongoose';

const ServiceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  price: { 
    type: Number,
    min: 0
  },
  parentId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Service', 
    default: null 
  }
});

const Service = mongoose.model('Service', ServiceSchema);
export default Service;
