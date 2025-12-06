// src/routes/paymentRoutes.js
import express from "express";
import { 
  initializePayment, 
  verifyPayment, 
  webhookPayment 
} from "../controllers/paymentController.js";
import { 
  getUserOrders, 
  getOrderById, 
  getAllOrders, 
  getOrderStats, 
  cancelOrder, 
  updateOrderStatus 
} from "../controllers/orderController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

/* ==================== HELPER MIDDLEWARE ==================== */

// Admin authorization middleware
const requireAdmin = (req, res, next) => {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ 
      success: false, 
      message: "Admin access required" 
    });
  }
  next();
};

/* ==================== PAYMENT ROUTES ==================== */

// Webhook - NO express.raw() here! Must be in app.js
// NO authentication (signature verified in controller)
router.post("/webhook", webhookPayment);

// Initialize payment
router.post("/initialize", authMiddleware, initializePayment);

// Verify payment (optional fallback)
router.get("/verify/:reference", verifyPayment);

/* ==================== USER ORDER ROUTES ==================== */
// IMPORTANT: Specific routes MUST come before generic /:id routes

// Get logged-in user's orders (uses req.user._id from auth middleware)
router.get("/orders/my-orders", authMiddleware, getUserOrders);

// Cancel order (user or admin can cancel)
router.patch("/orders/:id/cancel", authMiddleware, cancelOrder);

// Get single order by ID (MUST be after /my-orders)
router.get("/orders/:id", authMiddleware, getOrderById);

/* ==================== ADMIN ROUTES ==================== */
// All admin routes require authentication + admin role

// Get order statistics
router.get("/admin/stats", authMiddleware, requireAdmin, getOrderStats);

// Get all orders
router.get("/admin/orders", authMiddleware, requireAdmin, getAllOrders);

// Update order status
router.patch("/admin/orders/:id/status", authMiddleware, requireAdmin, updateOrderStatus);

export default router;