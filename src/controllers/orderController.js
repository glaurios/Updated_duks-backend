import Order from "../models/order.js";
import Cart from "../models/cart.js";
import { sendEmail } from "../utils/Email.js"; // ✅ email utility

// ================= Admin & User routes =================
export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).populate("userId", "email name");
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

export const getUserOrders = async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id, paymentStatus: "paid" }).sort({ createdAt: -1 });
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch user orders" });
  }
};

export const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id).populate("userId", "email name");
    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch order" });
  }
};

// ================= Admin updates order status =================
export const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { orderStatus } = req.body;

    const order = await Order.findByIdAndUpdate(id, { orderStatus }, { new: true }).populate("userId", "email name");
    if (!order) return res.status(404).json({ message: "Order not found" });

    // ✅ Send email if order completed
    if (orderStatus === "completed") {
      await sendEmail({
        to: order.userId.email,
        subject: "Order Completed ✅",
        html: `<p>Your order <b>${order._id}</b> has been completed/delivered. Thank you for shopping with us!</p>`
      });
    }

    res.json({ message: "Order status updated", order });
  } catch (err) {
    res.status(500).json({ message: "Failed to update order status" });
  }
};

// ================= Cancel order =================
export const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findByIdAndUpdate(
      id,
      { orderStatus: "cancelled", paymentStatus: "refunded" },
      { new: true }
    ).populate("userId", "email name");

    if (!order) return res.status(404).json({ message: "Order not found" });

    // ✅ Send email notification
    await sendEmail({
      to: order.userId.email,
      subject: "Order Cancelled ❌",
      html: `<p>Your order <b>${order._id}</b> has been cancelled. Payment has been refunded if applicable.</p>`
    });

    res.json({ message: "Order cancelled", order });
  } catch (err) {
    res.status(500).json({ message: "Failed to cancel order" });
  }
};

// ================= Admin stats =================
export const getOrderStats = async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const totalRevenueAgg = await Order.aggregate([
      { $match: { paymentStatus: "paid" } },
      { $group: { _id: null, totalRevenue: { $sum: "$totalAmount" } } },
    ]);
    const totalRevenue = totalRevenueAgg[0]?.totalRevenue || 0;
    res.json({ totalOrders, totalRevenue });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch stats" });
  }
};

// =================== Webhook & Checkout ===================

// Create order from checkout (manual POST route)
export const createOrderFromCheckout = async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ message: "Missing payment reference" });

    const userId = req.user._id;
    const cartItems = await Cart.find({ userId }).populate("drinkId");
    if (!cartItems.length) return res.status(404).json({ message: "Cart is empty" });

    let totalAmount = 0;
    const items = cartItems.map(item => {
      const price = item.drinkId.packs[0]?.price || 0;
      totalAmount += price * item.quantity;
      return {
        drinkId: item.drinkId._id,
        name: item.drinkId.name,
        price,
        quantity: item.quantity
      };
    });

    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items,
        totalAmount,
        paymentStatus: "paid",
        orderStatus: "confirmed",
        paystackReference: reference
      });

      // ✅ Send email notifications
      await sendEmail({
        to: req.user.email,
        subject: "Order Confirmed ✅",
        html: `<p>Your order <b>${reference}</b> has been successfully placed and confirmed.</p>
               <p>Total Amount: GHS ${totalAmount}</p>`
      });
      await sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: "New Order Placed 🛒",
        html: `<p>New order <b>${reference}</b> has been placed by ${req.user.email}.</p>
               <p>Total Amount: GHS ${totalAmount}</p>`
      });
    }

    await Cart.deleteMany({ userId });
    res.status(201).json({ success: true, order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create order" });
  }
};

// =================== Paystack Webhook ===================
export const webhookPayment = async (req, res) => {
  try {
    console.log("💥 Paystack Webhook received at server:", new Date());
    console.log("📦 Payload:", req.body);

    const { event, data } = req.body;
    if (event === "charge.success") {
      const { reference, metadata, amount } = data;
      const { userId, items } = metadata;
      const totalAmount = amount / 100;

      // Avoid duplicates
      let order = await Order.findOne({ paystackReference: reference });
      if (!order) {
        order = await Order.create({
          userId,
          items,
          totalAmount,
          paystackReference: reference,
          paymentStatus: "paid",
          orderStatus: "confirmed"
        });
        console.log(`✅ Order created for reference ${reference}`);

        // ✅ Send email notifications
        await sendEmail({
          to: metadata.email || "", 
          subject: "Order Confirmed ✅",
          html: `<p>Your order <b>${reference}</b> has been successfully placed and confirmed.</p>
                 <p>Total Amount: GHS ${totalAmount}</p>`
        });
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: "New Order Placed 🛒",
          html: `<p>New order <b>${reference}</b> has been placed.</p>
                 <p>Total Amount: GHS ${totalAmount}</p>`
        });
      } else {
        console.log(`⚠️ Order already exists for reference ${reference}`);
      }

      // ✅ Clear entire cart for user
      await Cart.deleteMany({ userId });
      console.log(`🧹 Cart cleared for user ${userId}`);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
};


      // Clear cart
      await Cart.findOneAndUpdate({ userId }, { items: [] });
      console.log(`🧹 Cart cleared for user ${userId}`);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
};
