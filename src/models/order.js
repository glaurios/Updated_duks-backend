// src/models/order.js
import mongoose from "mongoose";


const customerSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      trim: true,
      required: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email format"],
    },
    phone: {
      type: String,
      trim: true,
      required: true,
      match: [/^\+?[0-9]{7,15}$/, "Invalid phone number"],
    },
    address: {
      type: String,
      trim: true,
      required: true,
    },
    city: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "Ghana" },
  },
  { _id: false }
);

const itemSchema = new mongoose.Schema(
  {
    drinkId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Drink",
      required: true,
      index: true,
    },
    image: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, required: true },
    pack: { type: String, trim: true },
    price: {
      type: Number,
      required: true,
      min: [0, "Price cannot be negative"],
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, "Quantity must be at least 1"],
    },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false, // allow guest orders
    },

    customer: {
      type: customerSchema,
      required: true,
    },

    items: {
      type: [itemSchema],
      validate: {
        validator: arr => arr.length > 0,
        message: "Order must contain at least one item",
      },
    },

    deliveryDate: {
      type: Date,
      default: null,
      set: v => (isNaN(Date.parse(v)) ? null : new Date(v)),
    },

    deliveryTime: {
      type: String,
      trim: true,
      default: null,
    },

    totalAmount: {
      type: Number,
      required: true,
      min: [0, "Total amount cannot be negative"],
    },

    paystackReference: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },

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

    orderNumber: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },

    vendor: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator: v => !v || /^[a-zA-Z0-9-_ ]+$/.test(v),
        message: "Vendor contains invalid characters",
      },
    },
  },
  { timestamps: true }
);

// Helpful indexes for admin dashboards
orderSchema.index({ createdAt: -1 });
orderSchema.index({ userId: 1 });
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ orderStatus: 1 });

export default mongoose.model("Order", orderSchema);
