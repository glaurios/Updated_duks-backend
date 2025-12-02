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
 *   the request body should include { reference, customer, deliveryDate, deliveryTime }
 *   or you can rely on the server-side Cart to build items and use req.body.customer for customer info.
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
    const orders = await Order.find({
      userId: req.user._id,
      paymentStatus: "paid",
    }).sort({ createdAt: -1 });

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
      await sendEmail({
        to: order.userId.email,
        subject: "Order Completed ✅",
        html: `<p>Hi ${order.userId.name || ""},</p>
               <p>Your order <strong>${order._id}</strong> has been marked as <strong>Completed</strong>. Thank you for shopping with Duk's Juices!</p>`,
      });
    }

    res.json({ message: "Order status updated", order });
  } catch (err) {
    console.error("Update order status error:", err);
    res.status(500).json({ message: "Failed to update order status" });
  }
};

/* ----------------- Cancel order ----------------- */

export const cancelOrder = async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { orderStatus: "cancelled", paymentStatus: "refunded" },
      { new: true }
    ).populate("userId", "email name");

    if (!order) return res.status(404).json({ message: "Order not found" });

    await sendEmail({
      to: order.userId.email,
      subject: "Order Cancelled ❌",
      html: `<p>Hi ${order.userId.name || ""},</p>
             <p>Your order <strong>${order._id}</strong> has been cancelled. If payment was made, a refund will be processed according to our refund policy.</p>`,
    });

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

export const createOrderFromCheckout = async (req, res) => {
  try {
    const { reference, customer, deliveryDate, deliveryTime } = req.body;
    if (!reference) return res.status(400).json({ message: "Missing payment reference" });

    const userId = req.user._id;

    // Fetch cart items for the user
    const cartItems = await Cart.find({ userId }).populate("drinkId");
    if (!cartItems || cartItems.length === 0) {
      return res.status(404).json({ message: "Cart is empty" });
    }

    let totalAmount = 0;
    const items = cartItems.map((ci) => {
      // Select the correct pack using ci.pack
      const selectedPack = ci.drinkId.packs?.find(p => p.pack === ci.pack) || ci.drinkId.packs?.[0];
      const price = selectedPack?.price || 0;
      totalAmount += price * ci.quantity;

      return {
        drinkId: ci.drinkId._id,
        image: ci.drinkId.image || ci.drinkId.imageUrl || "",
        name: ci.drinkId.name,
        pack: selectedPack?.pack || null,
        price,
        quantity: ci.quantity,
      };
    });

    // Avoid duplicate orders
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

      // Notify customer
      if (customer?.email) {
        await sendEmail({
          to: customer.email,
          subject: "Your Order is Confirmed ✅",
          html: `<p>Hi ${customer.fullName || "Customer"},</p>
                 <p>Your order <b>${order._id}</b> has been confirmed. Thank you for shopping with Duk's Juices!</p>
                 <ul>${items.map(i => `<li>${i.quantity} × ${i.name} (${i.pack ?? ""}) — ₵${i.price}</li>`).join("")}</ul>
                 <p><strong>Total:</strong> ₵${totalAmount}</p>
                 ${deliveryDate ? `<p><strong>Delivery:</strong> ${deliveryDate} ${deliveryTime ? "at " + deliveryTime : ""}</p>` : ""}`
        });
      }

      // Notify admin
      if (process.env.ADMIN_EMAIL) {
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: "New Order Received 🛒",
          html: `<p>New order <b>${order._id}</b> placed by ${customer?.fullName || req.user._id} (${customer?.email || "no-email"}). Total: ₵${totalAmount}</p>`
        });
      }
    }

    // Clear user's cart
    await Cart.deleteMany({ userId });

    res.status(201).json({ success: true, order });
  } catch (err) {
    console.error("Create order from checkout error:", err);
    res.status(500).json({ message: "Failed to create order" });
  }
};

/* ----------------- Paystack Webhook ----------------- */

export const webhookPayment = async (req, res) => {
  try {
    console.log("💥 Paystack Webhook received:", new Date().toISOString());
    console.log("📦 Payload:", req.body);

    const { event, data } = req.body;
    if (event !== "charge.success") return res.status(200).send("Ignored");

    const { reference, metadata, amount } = data;
    const { cart, customer, deliveryDate, deliveryTime, userId } = metadata;

    if (!cart || !userId) {
      console.warn("Webhook missing metadata.cart or metadata.userId — nothing to save");
      return res.status(400).send("Missing metadata");
    }

    let totalAmount = amount / 100;
    const items = cart.map(item => ({
      drinkId: item.drinkId,
      image: item.image || item.imageUrl || "",
      name: item.name,
      pack: item.pack || null,
      price: item.price,
      quantity: item.quantity,
    }));

    // Avoid duplicate orders
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

      // Notify customer
      const toEmail = (customer && customer.email) || (metadata && metadata.email) || null;
      if (toEmail) {
        await sendEmail({
          to: toEmail,
          subject: "Your Order is Confirmed ✅",
          html: `<p>Hi ${customer?.fullName || ""},</p>
                 <p>Your order <b>${order._id}</b> has been confirmed.</p>
                 <ul>${items.map(i => `<li>${i.quantity} × ${i.name} (${i.pack ?? ""}) — ₵${i.price}</li>`).join("")}</ul>
                 <p><strong>Total:</strong> ₵${totalAmount}</p>
                 ${deliveryDate ? `<p><strong>Delivery:</strong> ${deliveryDate} ${deliveryTime ? "at " + deliveryTime : ""}</p>` : ""}`
        });
      }

      // Notify admin
      if (process.env.ADMIN_EMAIL) {
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: "New Order Received 🛒",
          html: `<p>New order <b>${order._id}</b> placed by ${customer?.fullName || userId}. Total: ₵${totalAmount}</p>`
        });
      }
    }

    // Clear user's cart
    await Cart.deleteMany({ userId });

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).send("Webhook failed");
  }
};
