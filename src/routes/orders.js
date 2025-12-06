// src/routes/orders.js
import express from "express";
import {
  getUserOrders,
  getOrderById,
  getAllOrders,
  getOrderStats,
  cancelOrder,
  updateOrderStatus,
} from "../controllers/orderController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

/* ==================== HELPER MIDDLEWARE ==================== */

// Admin check middleware
const requireAdmin = (req, res, next) => {
  if (!req.user?.isAdmin) {
    return res.status(403).json({
      success: false,
      message: "Admin access required",
    });
  }
  next();
};

/* ==================== ADMIN ORDER ROUTES (SPECIFIC FIRST) ==================== */

// Get order statistics (admin only)
router.get("/admin/stats", authMiddleware, requireAdmin, getOrderStats);

// Get all orders (admin only) — also support GET / (so front-end calling GET /orders works)
router.get("/admin/all", authMiddleware, requireAdmin, getAllOrders);
router.get("/", authMiddleware, requireAdmin, getAllOrders);

// Update order status (admin only)
// accept PUT and PATCH on both /:id/status and /admin/:id/status for compatibility
router.put("/admin/:id/status", authMiddleware, requireAdmin, updateOrderStatus);
router.patch("/admin/:id/status", authMiddleware, requireAdmin, updateOrderStatus);

router.put("/:id/status", authMiddleware, requireAdmin, updateOrderStatus);
router.patch("/:id/status", authMiddleware, requireAdmin, updateOrderStatus);

/* ==================== USER ORDER ROUTES (SPECIFIC BEFORE GENERIC) ==================== */

// Get logged-in user's orders
router.get("/my-orders", authMiddleware, getUserOrders);

// Cancel order (allow both PUT and PATCH to match client)
router.put("/:id/cancel", authMiddleware, cancelOrder);
router.patch("/:id/cancel", authMiddleware, cancelOrder);

// Get single order by ID (generic param route should come AFTER all specific routes)
router.get("/:id", authMiddleware, getOrderById);

export default router;
