const mongoose = require('mongoose');

const helpSchema = new mongoose.Schema({
    content: {
        type: String,
        required: true,
        default: 'This is the default help message. Please edit it in the admin settings.'
    }
}, { timestamps: true });

// Ensure there is only one help document in the collection
helpSchema.statics.findOneOrCreate = async function() {
    let help = await this.findOne();
    if (!help) {
        help = await this.create({});
    }
    return help;
};

const Help = mongoose.model('Help', helpSchema);

module.exports = Help;
