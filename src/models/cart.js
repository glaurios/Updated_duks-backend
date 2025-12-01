import mongoose from "mongoose";

const cartItemSchema = new mongoose.Schema({
  drinkId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Drink",
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    default: 1,
    min: 1,
  },
});

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    items: [cartItemSchema], // 👈 Now supports multiple cart items
  },
  { timestamps: true }
);

export default mongoose.model("Cart", cartSchema);
