// src/models/order.js
import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false, // allow guest orders if needed
    },

    customer: {
      fullName: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      address: { type: String, default: "" },
      city: { type: String, default: "" },
      country: { type: String, default: "Ghana" },
    },

    items: [
      {
        drinkId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Drink",
          required: true,
        },
        image: { type: String, default: "" },
        name: { type: String, required: true },
        pack: { type: String }, // like 500ml, 1L
        price: { type: Number, required: true },
        quantity: { type: Number, required: true },
      },
    ],

    deliveryDate: { type: Date, default: null }, // store as Date for clarity
    deliveryTime: { type: String, default: null },

    totalAmount: { type: Number, required: true },

    paystackReference: { type: String, required: true, unique: true },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "refunded"],
      default: "pending",
    },
    orderStatus: {
      type: String,
      enum: ["confirmed", "processing", "completed", "cancelled"],
      default: "confirmed",
    },

    orderNumber: { type: String, index: true, unique: true }, // "000001"
    vendor: { type: String, default: "" }, // e.g. "jumia"
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);
