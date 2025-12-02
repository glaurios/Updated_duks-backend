// src/utils/orderNumber.js
import Counter from "../models/counter.js";

export async function getNextOrderNumber() {
  const counter = await Counter.findOneAndUpdate(
    { _id: "orderNumber" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return String(counter.seq).padStart(6, "0"); // "000001"
}
