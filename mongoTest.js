require("dotenv").config();
const mongoose = require("mongoose");

const CurrencySchema = new mongoose.Schema({
  code: String,
  symbol: String,
  name: String,
  isActive: Boolean,
  rate: Number,
});
const Currency = mongoose.model("Currency", CurrencySchema);

async function test() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Connected");
    const cur = await Currency.findOne();
    console.log("Currency:", cur);
    process.exit(0);
  } catch (e) {
    console.error("Error:", e);
    process.exit(1);
  }
}

test();
