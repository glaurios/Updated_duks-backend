import mongoose from "mongoose";

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // ✅ references the User collection
      required: true,
    },
    drinkId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Drink", // ✅ references the Drink collection
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
  },
  { timestamps: true }
);

// ✅ Compound unique index to prevent duplicate items for same user, drink, and pack
cartSchema.index({ userId: 1, drinkId: 1, pack: 1 }, { unique: true });

export default mongoose.model("Cart", cartSchema);
