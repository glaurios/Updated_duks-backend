import express from "express";
import { initializePayment, verifyPayment, webhookPayment } from "../controllers/paymentController.js";
import { getUserOrders, getOrderById, getAllOrders, getOrderStats, cancelOrder, updateOrderStatus } from "../controllers/orderController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

// Payments
router.post("/initialize", authMiddleware, initializePayment);
router.get("/verify/:reference", verifyPayment);
router.post("/webhook", webhookPayment);

// Orders
router.get("/user/:userId", authMiddleware, getUserOrders);
router.get("/:id", authMiddleware, getOrderById);

// Admin routes
router.get("/", getAllOrders);
router.get("/stats/dashboard", getOrderStats);
router.patch("/:id/status", updateOrderStatus);
router.patch("/:id/cancel", authMiddleware, cancelOrder);

export default router;
