// src/controllers/orderController.js
import Order from "../models/order.js";
import { sendEmail } from "../utils/Email.js";

/* ==================== HELPERS ==================== */

// Structured logging
const logOrderEvent = (event, data) => {
  console.log(`[ORDER ${event}]`, {
    ...data,
    timestamp: new Date().toISOString(),
  });
};

/* ==================== GET USER ORDERS ==================== */
export const getUserOrders = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ 
        success: false, 
        message: "Unauthorized" 
      });
    }

    const orders = await Order.find({ userId })
      .sort({ createdAt: -1 })
      .lean();

    logOrderEvent("FETCH_USER_ORDERS", { 
      userId, 
      count: orders.length 
    });

    return res.json({ 
      success: true, 
      orders 
    });
  } catch (error) {
    console.error("Get user orders error:", error);
    logOrderEvent("FETCH_USER_ORDERS_ERROR", {
      userId: req.user?._id,
      error: error.message,
    });
    
    return res.status(500).json({ 
      success: false,
      message: "Failed to fetch orders" 
    });
  }
};

/* ==================== GET ORDER BY ID ==================== */
export const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.user?.id;
    const isAdmin = req.user?.isAdmin;

    const order = await Order.findById(id)
      .populate("userId", "email name fullName")
      .lean();

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: "Order not found" 
      });
    }

    // Check authorization (owner or admin)
    const orderUserId = order.userId?._id?.toString() || order.userId?.toString();
    const requestUserId = userId?.toString();

    if (orderUserId !== requestUserId && !isAdmin) {
      return res.status(403).json({ 
        success: false, 
        message: "Not authorized to view this order" 
      });
    }

    logOrderEvent("FETCH_ORDER_BY_ID", { 
      orderId: order._id,
      userId: requestUserId 
    });

    return res.json({ 
      success: true, 
      order 
    });
  } catch (error) {
    console.error("Get order by ID error:", error);
    
    return res.status(500).json({ 
      success: false,
      message: "Failed to fetch order" 
    });
  }
};

/* ==================== GET ALL ORDERS (ADMIN) ==================== */
export const getAllOrders = async (req, res) => {
  try {
    // Verify admin access
    if (!req.user?.isAdmin) {
      return res.status(403).json({ 
        success: false, 
        message: "Admin access required" 
      });
    }

    const orders = await Order.find()
      .sort({ createdAt: -1 })
      .populate("userId", "email name fullName")
      .lean();

    logOrderEvent("ADMIN_FETCH_ALL_ORDERS", { 
      count: orders.length,
      admin: req.user.email || req.user._id 
    });

    return res.json({ 
      success: true, 
      orders 
    });
  } catch (error) {
    console.error("Get all orders error:", error);
    logOrderEvent("ADMIN_FETCH_ORDERS_ERROR", {
      admin: req.user?.email,
      error: error.message,
    });
    
    return res.status(500).json({ 
      success: false,
      message: "Failed to fetch orders" 
    });
  }
};

/* ==================== GET ORDER STATISTICS (ADMIN) ==================== */
export const getOrderStats = async (req, res) => {
  try {
    // Verify admin access
    if (!req.user?.isAdmin) {
      return res.status(403).json({ 
        success: false, 
        message: "Admin access required" 
      });
    }

    // Total orders count
    const totalOrders = await Order.countDocuments();

    // Total revenue (only paid orders)
    const revenueAgg = await Order.aggregate([
      { $match: { paymentStatus: "paid" } },
      { $group: { _id: null, totalRevenue: { $sum: "$totalAmount" } } },
    ]);
    const totalRevenue = revenueAgg[0]?.totalRevenue || 0;

    // Orders by status
    const ordersByStatus = await Order.aggregate([
      {
        $group: {
          _id: "$orderStatus",
          count: { $sum: 1 },
        },
      },
    ]);

    // Recent orders (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const recentOrders = await Order.countDocuments({
      createdAt: { $gte: sevenDaysAgo },
    });

    // Pending orders
    const pendingOrders = await Order.countDocuments({
      orderStatus: { $in: ["pending", "confirmed"] },
    });

    const stats = {
      totalOrders,
      totalRevenue,
      recentOrders,
      pendingOrders,
      ordersByStatus: ordersByStatus.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
    };

    logOrderEvent("ADMIN_FETCH_STATS", { 
      admin: req.user.email || req.user._id 
    });

    return res.json({ 
      success: true, 
      stats 
    });
  } catch (error) {
    console.error("Get order stats error:", error);
    
    return res.status(500).json({ 
      success: false,
      message: "Failed to fetch statistics" 
    });
  }
};

/* ==================== UPDATE ORDER STATUS (ADMIN) ==================== */
export const updateOrderStatus = async (req, res) => {
  try {
    // Verify admin access
    if (!req.user?.isAdmin) {
      return res.status(403).json({ 
        success: false, 
        message: "Admin access required" 
      });
    }

    const { id } = req.params;
    const { orderStatus } = req.body;

    // Validate status
    const validStatuses = [
      "pending",
      "confirmed", 
      "processing", 
      "shipped", 
      "delivered", 
      "completed", 
      "cancelled"
    ];

    if (!validStatuses.includes(orderStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order status",
        validStatuses,
      });
    }

    const order = await Order.findByIdAndUpdate(
      id,
      { orderStatus },
      { new: true }
    ).populate("userId", "email name fullName");

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: "Order not found" 
      });
    }

    logOrderEvent("STATUS_UPDATED", {
      orderId: order._id,
      newStatus: orderStatus,
      updatedBy: req.user.email || req.user._id,
    });

    // Send email notification for important status changes
    const emailStatuses = ["shipped", "delivered", "completed"];
    if (emailStatuses.includes(orderStatus) && order.customer?.email) {
      try {
        const statusMessages = {
          shipped: "Your order has been shipped and is on its way! 📦",
          delivered: "Your order has been delivered. We hope you enjoy it! 🎉",
          completed: "Your order is complete. Thank you for shopping with us! ✅",
        };

        await sendEmail({
          to: order.customer.email,
          subject: `Order Update - ${order._id}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #0f5132; color: #fff; padding: 20px; border-radius: 8px 8px 0 0;">
                <h2 style="margin: 0;">Order Status Update</h2>
              </div>
              <div style="padding: 20px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
                <p>Hi ${order.customer.fullName},</p>
                <p>${statusMessages[orderStatus] || `Your order status has been updated to: <strong>${orderStatus}</strong>`}</p>
                
                <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
                  <p style="margin: 5px 0;"><strong>Order ID:</strong> ${order._id}</p>
                  <p style="margin: 5px 0;"><strong>Status:</strong> <span style="color: #0f5132; font-weight: bold;">${orderStatus.toUpperCase()}</span></p>
                  <p style="margin: 5px 0;"><strong>Total:</strong> ₵${order.totalAmount.toFixed(2)}</p>
                </div>

                ${orderStatus === "delivered" ? `
                  <p>If you have any issues with your order, please contact us immediately.</p>
                ` : ""}

                <p style="margin-top: 20px; color: #666; font-size: 14px;">
                  Thank you for choosing us!
                </p>
              </div>
            </div>
          `,
        });

        logOrderEvent("STATUS_EMAIL_SENT", {
          orderId: order._id,
          email: order.customer.email,
          status: orderStatus,
        });
      } catch (emailError) {
        console.error("Failed to send status update email:", emailError);
        logOrderEvent("STATUS_EMAIL_FAILED", {
          orderId: order._id,
          error: emailError.message,
        });
      }
    }

    return res.json({ 
      success: true, 
      message: "Order status updated successfully", 
      order 
    });
  } catch (error) {
    console.error("Update order status error:", error);
    
    return res.status(500).json({ 
      success: false,
      message: "Failed to update order status" 
    });
  }
};

/* ==================== CANCEL ORDER ==================== */
export const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.user?.id;
    const isAdmin = req.user?.isAdmin;

    const order = await Order.findById(id).populate("userId", "email name fullName");

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: "Order not found" 
      });
    }

    // Check authorization (owner or admin)
    const orderUserId = order.userId?._id?.toString() || order.userId?.toString();
    const requestUserId = userId?.toString();

    if (orderUserId !== requestUserId && !isAdmin) {
      return res.status(403).json({ 
        success: false, 
        message: "Not authorized to cancel this order" 
      });
    }

    // Prevent cancellation of already shipped/delivered orders
    const nonCancellableStatuses = ["shipped", "delivered", "completed"];
    if (nonCancellableStatuses.includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel order with status: ${order.orderStatus}`,
      });
    }

    // Update order status
    order.orderStatus = "cancelled";
    order.paymentStatus = order.paymentStatus === "paid" ? "refunded" : "cancelled";
    await order.save();

    logOrderEvent("ORDER_CANCELLED", {
      orderId: order._id,
      cancelledBy: req.user.email || requestUserId,
      previousStatus: order.orderStatus,
    });

    // Send cancellation email
    if (order.customer?.email) {
      try {
        await sendEmail({
          to: order.customer.email,
          subject: `Order Cancelled - ${order._id}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #dc3545; color: #fff; padding: 20px; border-radius: 8px 8px 0 0;">
                <h2 style="margin: 0;">Order Cancelled</h2>
              </div>
              <div style="padding: 20px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
                <p>Hi ${order.customer.fullName},</p>
                <p>Your order has been cancelled as requested.</p>
                
                <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
                  <p style="margin: 5px 0;"><strong>Order ID:</strong> ${order._id}</p>
                  <p style="margin: 5px 0;"><strong>Total Amount:</strong> ₵${order.totalAmount.toFixed(2)}</p>
                  ${order.paymentStatus === "refunded" ? `
                    <p style="margin: 5px 0; color: #0f5132;"><strong>Refund Status:</strong> Your refund will be processed within 5-7 business days.</p>
                  ` : ""}
                </div>

                <p>If you have any questions, please don't hesitate to contact us.</p>
                
                <p style="margin-top: 20px; color: #666; font-size: 14px;">
                  We hope to serve you again soon!
                </p>
              </div>
            </div>
          `,
        });

        logOrderEvent("CANCEL_EMAIL_SENT", {
          orderId: order._id,
          email: order.customer.email,
        });
      } catch (emailError) {
        console.error("Failed to send cancellation email:", emailError);
        logOrderEvent("CANCEL_EMAIL_FAILED", {
          orderId: order._id,
          error: emailError.message,
        });
      }
    }

    return res.json({ 
      success: true, 
      message: "Order cancelled successfully", 
      order 
    });
  } catch (error) {
    console.error("Cancel order error:", error);
    
    return res.status(500).json({ 
      success: false,
      message: "Failed to cancel order" 
    });
  }
};