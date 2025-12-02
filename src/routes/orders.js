// src/routes/orders.js
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

/* ============== CUSTOMER ROUTES ============== */

// Create order after successful Paystack checkout (frontend call)
router.post("/paystack/callback", authMiddleware, createOrderFromCheckout);

// Get logged-in user's orders
router.get("/my-orders", authMiddleware, getUserOrders);

// Get specific order by ID (only owner or admin)
router.get("/:id", authMiddleware, getOrderById);

// Cancel an order (Only user who owns it)
router.put("/:id/cancel", authMiddleware, cancelOrder);

/* ============== ADMIN ROUTES ============== */
router.get("/", authMiddleware, isAdmin, getAllOrders);
router.put("/:id/status", authMiddleware, isAdmin, updateOrderStatus);
router.get("/stats", authMiddleware, isAdmin, getOrderStats);

/* ============== WEBHOOK (PUBLIC ROUTE) ============== */
// Paystack↔Server automated callback
router.post("/webhook", webhookPayment);

export default router;
