import express from "express";
import {
  getAllOrders,
  getUserOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
  getOrderStats,
  createOrderFromCheckout,
  webhookPayment
} from "../controllers/orderController.js";

import { authMiddleware, isAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

// Admin
router.get("/", authMiddleware, isAdmin, getAllOrders);
router.get("/stats", authMiddleware, isAdmin, getOrderStats);
router.put("/:id", authMiddleware, isAdmin, updateOrderStatus);

// User
router.get("/my-orders", authMiddleware, getUserOrders);
router.get("/:id", authMiddleware, getOrderById);
router.put("/cancel/:id", authMiddleware, cancelOrder);

// Paystack
router.post("/paystack/callback", authMiddleware, createOrderFromCheckout);

// Webhook (Paystack triggers this automatically)
router.post("/paystack/webhook", express.json({ type: "*/*" }), webhookPayment);

export default router;
