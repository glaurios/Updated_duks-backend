// src/controllers/orderController.js
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import { sendEmail } from "../utils/Email.js";

/* ----------------- Admin & User routes ----------------- */

export const getAllOrders = async (req, res) => {
  try {
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
    const userId = req.user?._id || req.user?.id || req.user;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

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

/* ----------------- Manual checkout ----------------- */

export const createOrderFromCheckout = async (req, res) => {
  try {
    const { reference, customer, deliveryDate, deliveryTime } = req.body;
    if (!reference) return res.status(400).json({ message: "Missing payment reference" });

    const userId = req.user._id;

    // Use Cart to build items if available (this keeps images/name/pack stored)
    const cartItems = await Cart.find({ userId }).populate("drinkId");
    if (!cartItems || cartItems.length === 0) {
      return res.status(404).json({ message: "Cart is empty" });
    }

    let totalAmount = 0;
    const items = cartItems.map((ci) => {
      const selectedPack = ci.drinkId.packs?.find((p) => p._id?.toString() === (ci.packId?.toString() || "")) || ci.drinkId.packs?.[0];
      const price = selectedPack?.price || 0;
      totalAmount += price * ci.quantity;

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

    if (!items || items.length === 0) return res.status(400).json({ message: "No items to create order" });
    if (!totalAmount || totalAmount <= 0) return res.status(400).json({ message: "Invalid total amount" });

    // Create order (avoid duplicates)
    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        customer: customer || {}, // store provided customer object (fullName, email, phone, address...)
        deliveryDate: deliveryDate || null,
        deliveryTime: deliveryTime || null,
        items,
        totalAmount,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
      });

      // notify customer & admin
      if (customer?.email) {
        await sendEmail({
          to: customer.email,
          subject: "Your Order is Received — Payment Pending ⏳",
          html: `<p>Hi ${customer.fullName || "Customer"},</p>
                 <p>Thank you for shopping with <strong>Duk's Juices</strong>. Your order <b>${order._id}</b> has been confirmed.</p>
                 <p><strong>Order summary:</strong></p>
                 <ul>
                   ${items.map(i => `<li>${i.quantity} × ${i.name} (${i.pack ?? ""}) — ₵${i.price}</li>`).join("")}
                 </ul>
                 <p><strong>Total:</strong> ₵${totalAmount}</p>
                 ${deliveryDate ? `<p><strong>Delivery:</strong> ${deliveryDate} ${deliveryTime ? "at " + deliveryTime : ""}</p>` : ""}
                 <p>We’ll notify you when the order is out for delivery. Thank you!</p>`,
        });
      } catch (err) {
        console.warn("Failed to send order confirmation email:", err.message);
      }
    }

      if (process.env.ADMIN_EMAIL) {
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: "New Order Received 🛒",
          html: `<p>New order <b>${order._id}</b> placed by ${customer?.fullName || req.user._id} (${customer?.email || "no-email"}). Total: ₵${totalAmount}</p>`,
        });
      } catch (err) {
        console.warn("Failed to notify admin:", err.message);
      }
    }

    // Clear cart
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
    // Helpful server log for debugging webhook receipts
    console.log("💥 Paystack Webhook received at server:", new Date().toISOString());
    console.log("📦 Payload:", req.body);

    const { event, data } = req.body;
    if (event !== "charge.success") return res.status(200).send("Ignored");

    const { reference, metadata, amount } = data;
    const { cart, customer, deliveryDate, deliveryTime, userId } = metadata;

    if (!cart || !userId) {
      console.warn("Webhook missing metadata.cart or metadata.userId");
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
      }

      // Notify admin
      if (process.env.ADMIN_EMAIL) {
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: "New Order Received 🛒",
          html: `<p>New order <b>${order._id}</b> placed by ${customer?.fullName || userId}.</p>
                 <p>Total: ₵${totalAmount}</p>`,
        });
      }
    }

    // Clear user's cart if they exist in DB (metadata.userId)
    if (userId) {
      await Cart.deleteMany({ userId });
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).send("Webhook failed");
  }
};
