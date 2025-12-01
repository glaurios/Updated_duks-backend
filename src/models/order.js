import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
  drinkId: { type: mongoose.Schema.Types.ObjectId, ref: "Drink", required: true },
  name: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true },
});

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    items: [orderItemSchema],
    totalAmount: { type: Number, required: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },
    orderStatus: {
      type: String,
      enum: ["pending", "confirmed", "completed", "cancelled"],
      default: "pending",
    },
    paystackReference: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);
