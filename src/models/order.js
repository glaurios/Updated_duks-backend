// src/models/order.js
import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    customer: {
      fullName: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
      address: { type: String, required: true },
      city: { type: String, default: "" },
      country: { type: String, default: "Ghana" }, // optional
    },

    items: [
      {
        drinkId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Drink",
          required: true,
        },
        image: { type: String },
        name: { type: String, required: true },
        pack: { type: String }, // like 500ml, 1L
        price: { type: Number, required: true },
        quantity: { type: Number, required: true },
      },
    ],

    deliveryDate: { type: String, default: null }, // store as ISO string
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
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);
