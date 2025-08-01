import mongoose from 'mongoose';

const SmsSettingSchema = new mongoose.Schema({
    apiKey: { type: String, default: '' },
    sender: { type: String, default: '' },
    recipient: { type: String, default: '' }
});

// Static method to find or create the settings document
SmsSettingSchema.statics.findOneOrCreate = async function() {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

const SmsSetting = mongoose.model('SmsSetting', SmsSettingSchema);
export default SmsSetting;
