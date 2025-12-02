// src/controllers/orderController.js
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import { sendEmail } from "../utils/Email.js";

/**
 * Note:
 * - This controller expects `metadata` from Paystack to include:
 *   - cart: array of items (drinkId, name, price, quantity, image, pack)
 *   - customer: { fullName, email, phone, address, city, country }
 *   - deliveryDate (ISO string) and deliveryTime (string) — optional
 *
 * - For manual createOrderFromCheckout (POST /orders/paystack/callback or your manual route)
 *   the request body should include { reference, items, totalAmount, customer, deliveryDate, deliveryTime }
 *   or the server will fall back to the user's Cart to build items.
 */

/* ----------------- Admin & User routes ----------------- */

export const getAllOrders = async (req, res) => {
  try {
    // keep user info populated, but order.items already contains all product details
    const orders = await Order.find()
      .sort({ createdAt: -1 })
      .populate("userId", "email name");
    res.json({ orders });
  } catch (err) {
    console.error("Get all orders error:", err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

export const getUserOrders = async (req, res) => {
  try {
    // Accept req.user being a Mongoose user document (set in auth middleware)
    const userId = req.user?._id || req.user?.id || req.user;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Return all orders for the user (do not restrict by paymentStatus)
    const orders = await Order.find({ userId }).sort({ createdAt: -1 });

    res.json({ orders });
  } catch (err) {
    console.error("Get user orders error:", err);
    res.status(500).json({ message: "Failed to fetch user orders" });
  }
};

export const getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate("userId", "email name");
    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json({ order });
  } catch (err) {
    console.error("Get order by id error:", err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
};

/* ----------------- Admin updates order status ----------------- */

export const updateOrderStatus = async (req, res) => {
  try {
    const { orderStatus } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { orderStatus },
      { new: true }
    ).populate("userId", "email name");

    if (!order) return res.status(404).json({ message: "Order not found" });

    // notify user when delivered/completed
    if (orderStatus === "completed") {
      try {
        await sendEmail({
          to: order.userId.email,
          subject: "Order Completed ✅",
          html: `<p>Hi ${order.userId.name || ""},</p>
                 <p>Your order <strong>${order._id}</strong> has been marked as <strong>Completed</strong>. Thank you for shopping with Duk's Juices!</p>`,
        });
      } catch (err) {
        console.warn("Failed to send completion email:", err.message);
      }
    }

    res.json({ message: "Order status updated", order });
  } catch (err) {
    console.error("Update order status error:", err);
    res.status(500).json({ message: "Failed to update order status" });
  }
};

/* ----------------- Cancel order (with ownership check) ----------------- */

export const cancelOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate("userId", "email name");
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Only owner or admin can cancel
    const requesterId = req.user?._id?.toString() || req.user?.id?.toString();
    const ownerId = order.userId?._id?.toString() || order.userId?.toString();
    const isAdmin = req.user?.isAdmin;

    if (requesterId !== ownerId && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to cancel this order" });
    }

    order.orderStatus = "cancelled";
    order.paymentStatus = "refunded";
    await order.save();

    try {
      await sendEmail({
        to: order.userId.email,
        subject: "Order Cancelled ❌",
        html: `<p>Hi ${order.userId.name || ""},</p>
               <p>Your order <strong>${order._id}</strong> has been cancelled. If payment was made, a refund will be processed according to our refund policy.</p>`,
      });
    } catch (err) {
      console.warn("Failed to send cancel email:", err.message);
    }

    res.json({ message: "Order cancelled", order });
  } catch (err) {
    console.error("Cancel order error:", err);
    res.status(500).json({ message: "Failed to cancel order" });
  }
};

/* ----------------- Admin stats ----------------- */

export const getOrderStats = async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const revenueAgg = await Order.aggregate([
      { $match: { paymentStatus: "paid" } },
      { $group: { _id: null, totalRevenue: { $sum: "$totalAmount" } } },
    ]);
    const totalRevenue = revenueAgg[0]?.totalRevenue || 0;

    res.json({ totalOrders, totalRevenue });
  } catch (err) {
    console.error("Get order stats error:", err);
    res.status(500).json({ message: "Failed to fetch stats" });
  }
};

/* ----------------- Manual checkout: create order from checkout (POST) ----------------- */

/**
 * createOrderFromCheckout
 *
 * Expected body from frontend:
 * {
 *   reference: string,
 *   items?: [ { drinkId, name, price, quantity, image, pack } ],
 *   totalAmount?: number,
 *   customer?: { fullName, email, phone, address, city, country },
 *   deliveryDate?: string,
 *   deliveryTime?: string
 * }
 *
 * If items are not provided, this function will attempt to build items from the server-side Cart.
 * The created order will have paymentStatus: "pending" until the webhook marks it "paid".
 */
export const createOrderFromCheckout = async (req, res) => {
  try {
    const {
      reference,
      items: bodyItems,
      customer,
      totalAmount: bodyTotal,
      deliveryDate,
      deliveryTime,
    } = req.body;

    const userId = req.user?._id || req.user?.id || req.user;

    if (!reference) {
      return res.status(400).json({ message: "Missing payment reference" });
    }

    // Primary source of items is frontend payload
    let items = Array.isArray(bodyItems) && bodyItems.length ? bodyItems : null;
    let totalAmount = bodyTotal ?? null;

    // If frontend didn't provide items, fall back to server-side Cart
    if (!items) {
      const cartItems = await Cart.find({ userId }).populate("drinkId");
      if (!cartItems || cartItems.length === 0) {
        return res.status(404).json({ message: "Cart is empty and no items were provided" });
      }

      totalAmount = 0;
      items = cartItems.map((ci) => {
        const selectedPack =
          ci.drinkId?.packs?.find((p) => p._id?.toString() === (ci.packId?.toString() || "")) ||
          ci.drinkId?.packs?.[0];

        const price = selectedPack?.price || 0;
        totalAmount += price * (ci.quantity || 1);

        return {
          drinkId: ci.drinkId._id,
          image: ci.drinkId.image || ci.drinkId.imageUrl || "",
          name: ci.drinkId.name,
          pack: selectedPack?.pack || null,
          price,
          quantity: ci.quantity || 1,
        };
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ message: "No items to create order" });
    }
    if (!totalAmount || totalAmount <= 0) {
      return res.status(400).json({ message: "Invalid total amount" });
    }

    // Prevent duplicate orders for same reference
    let order = await Order.findOne({ paystackReference: reference });
    if (order) {
      return res.status(200).json({ success: true, message: "Order already exists", order });
    }

    // Create order with pending payment status (webhook will mark 'paid')
    order = await Order.create({
      userId,
      customer: customer || {},
      deliveryDate: deliveryDate || null,
      deliveryTime: deliveryTime || null,
      items,
      totalAmount,
      paystackReference: reference,
      paymentStatus: "pending",
      orderStatus: "confirmed",
    });

    // Notify customer (if email provided)
    if (customer?.email) {
      try {
        await sendEmail({
          to: customer.email,
          subject: "Your Order is Received — Payment Pending ⏳",
          html: `<p>Hi ${customer.fullName || "Customer"},</p>
                 <p>Thanks for placing an order with Duk's Juices. We received your order <strong>${order._id}</strong>.</p>
                 <p><strong>Order summary:</strong></p>
                 <ul>
                  ${items.map(i => `<li>${i.quantity} × ${i.name} (${i.pack ?? ""}) — ₵${i.price}</li>`).join("")}
                 </ul>
                 <p><strong>Total:</strong> ₵${totalAmount}</p>
                 ${deliveryDate ? `<p><strong>Delivery:</strong> ${deliveryDate} ${deliveryTime ? "at " + deliveryTime : ""}</p>` : ""}
                 <p>We will notify you when payment is confirmed and your order is being prepared.</p>`,
        });
      } catch (err) {
        console.warn("Failed to send order confirmation email to customer:", err.message);
      }
    }

    // Notify admin
    if (process.env.ADMIN_EMAIL) {
      try {
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: "New Order Initiated (Payment Pending)",
          html: `<p>New order <b>${order._id}</b> placed by ${customer?.fullName || userId} (${customer?.email || "no-email"}). Total: ₵${totalAmount}</p>`,
        });
      } catch (err) {
        console.warn("Failed to send new order email to admin:", err.message);
      }
    }

    // Clear cart (best-effort)
    try {
      await Cart.deleteMany({ userId });
    } catch (err) {
      console.warn("Failed to clear cart after order creation:", err.message);
    }

    res.status(201).json({ success: true, order });
  } catch (err) {
    console.error("Create order from checkout error:", err);
    res.status(500).json({ message: "Failed to create order" });
  }
};

/* ----------------- Paystack Webhook ----------------- */

export const webhookPayment = async (req, res) => {
  try {
    // Helpful server log for debugging webhook receipts
    console.log("💥 Paystack Webhook received at server:", new Date().toISOString());
    console.log("📦 Payload:", req.body);

    const { event, data } = req.body;
    if (event !== "charge.success") return res.status(200).send("Ignored");

    const { reference, metadata, amount } = data;
    // metadata must include: cart (items), customer (optional), deliveryDate/time (optional), userId
    const { cart, customer, deliveryDate, deliveryTime, userId } = metadata || {};

    if (!cart || !userId) {
      console.warn("Webhook missing metadata.cart or metadata.userId — nothing to save");
      return res.status(400).send("Missing metadata");
    }

    // Build items from metadata.cart (frontend must send full item objects)
    const items = cart.map((item) => ({
      drinkId: item.drinkId,
      image: item.image || item.imageUrl || "",
      name: item.name,
      pack: item.pack || null,
      price: item.price,
      quantity: item.quantity,
    }));

    const totalAmount = amount / 100;

    // Avoid duplicate creation
    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        customer: customer || {},
        deliveryDate: deliveryDate || null,
        deliveryTime: deliveryTime || null,
        items,
        totalAmount,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
      });

      console.log("🛍️ New Order Saved (webhook):", order._id);

      // notify customer (if email in metadata or customer)
      const toEmail = (customer && customer.email) || (metadata && metadata.email) || null;
      if (toEmail) {
        try {
          await sendEmail({
            to: toEmail,
            subject: "Your Order is Confirmed ✅",
            html: `<p>Hi ${customer?.fullName || ""},</p>
                   <p>Thanks for shopping with <strong>Duk's Juices</strong>. Your order <b>${order._id}</b> is confirmed.</p>
                   <p><strong>Items:</strong></p>
                   <ul>${items.map(i => `<li>${i.quantity} × ${i.name} (${i.pack ?? ""}) — ₵${i.price}</li>`).join("")}</ul>
                   <p><strong>Total:</strong> ₵${totalAmount}</p>
                   ${deliveryDate ? `<p><strong>Delivery:</strong> ${deliveryDate} ${deliveryTime ? "at " + deliveryTime : ""}</p>` : ""}
                   <p>We’ll notify you when the order is out for delivery. Thank you!</p>`,
          });
        } catch (err) {
          console.warn("Email send failed:", err.message);
        }
      }

      // Notify admin
      if (process.env.ADMIN_EMAIL) {
        try {
          await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: "New Order Received 🛒",
            html: `<p>New order <b>${order._id}</b> placed by ${customer?.fullName || userId}.</p>
                   <p>Total: ₵${totalAmount}</p>`,
          });
        } catch (err) {
          console.warn("Admin email failed:", err.message);
        }
      }
    } else {
      console.log(`⚠️ Order already exists for reference ${reference}`);
    }

    // Clear user's cart if they exist in DB (metadata.userId)
    if (userId) {
      try {
        await Cart.deleteMany({ userId });
      } catch (err) {
        console.warn("Failed to clear user's cart from webhook:", err.message);
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).send("Webhook failed");
  }
};
