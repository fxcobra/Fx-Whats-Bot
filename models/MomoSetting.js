import mongoose from 'mongoose';

const MomoSettingSchema = new mongoose.Schema({
    environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
    apiUser: { type: String, default: '' },
    apiKey: { type: String, default: '' },
    subscriptionKey: { type: String, default: '' },
    currency: { type: String, default: 'EUR' }
});

// Static method to find or create the settings document
MomoSettingSchema.statics.findOneOrCreate = async function() {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

const MomoSetting = mongoose.model('MomoSetting', MomoSettingSchema);
export default MomoSetting;
