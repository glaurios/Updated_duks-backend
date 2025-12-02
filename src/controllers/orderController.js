// src/controllers/orderController.js
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import drinks from "../models/drinks.js";
import { sendEmail } from "../utils/Email.js";
import { getNextOrderNumber } from "../utils/orderNumber.js";

/* ----------------- Helpers ----------------- */
const sanitizeCustomer = (input = {}) => ({
  fullName: (input.fullName || "").replace(/\bnull\b/gi, "").trim(),
  email: (input.email || "").replace(/\bnull\b/gi, "").trim(),
  phone: (input.phone || "").replace(/\bnull\b/gi, "").trim(),
  address: (input.address || "").replace(/\bnull\b/gi, "").trim(),
  city: (input.city || "").replace(/\bnull\b/gi, "").trim(),
  country: (input.country || "Ghana").replace(/\bnull\b/gi, "").trim(),
});

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

/* ----------------- Update / Cancel ----------------- */
export const updateOrderStatus = async (req, res) => {
  try {
    const { orderStatus } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { orderStatus },
      { new: true }
    ).populate("userId", "email name");

    if (!order) return res.status(404).json({ message: "Order not found" });

    // Email customer if completed
    if (orderStatus === "completed" && order.userId?.email) {
      try {
        await sendEmail({
          to: order.userId.email,
          subject: `Order Completed ✅ — ${order.orderNumber}`,
          html: `<p>Hi ${order.userId.name || ""},</p>
                 <p>Your order <strong>${order.orderNumber}</strong> has been marked as <strong>Completed</strong>.</p>`,
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

export const cancelOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate("userId", "email name");
    if (!order) return res.status(404).json({ message: "Order not found" });

    const requesterId = req.user?._id?.toString() || req.user?.id?.toString();
    const ownerId = order.userId?._id?.toString() || order.userId?.toString();
    const isAdmin = req.user?.isAdmin;

    if (requesterId !== ownerId && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to cancel this order" });
    }

    order.orderStatus = "cancelled";
    order.paymentStatus = "refunded";
    await order.save();

    if (order.userId?.email) {
      try {
        await sendEmail({
          to: order.userId.email,
          subject: `Order Cancelled ❌ — ${order.orderNumber}`,
          html: `<p>Hi ${order.userId.name || ""},</p>
                 <p>Your order <strong>${order.orderNumber}</strong> has been cancelled.</p>`,
        });
      } catch (err) {
        console.warn("Failed to send cancel email:", err.message);
      }
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

/* ----------------- Create Order (Checkout / Webhook) ----------------- */
export const createOrderFromCheckout = async (req, res) => {
  try {
    const {
      reference,
      items: bodyItems,
      customer: rawCustomer,
      totalAmount: bodyTotal,
      deliveryDate,
      deliveryTime,
      vendor,
    } = req.body;

    const userId = req.user?._id || req.user?.id || req.user;
    if (!reference) return res.status(400).json({ message: "Missing payment reference" });

    const customer = sanitizeCustomer(rawCustomer || {});

    let items = Array.isArray(bodyItems) && bodyItems.length ? bodyItems : null;
    let totalAmount = typeof bodyTotal === "number" ? bodyTotal : 0;

    if (items) {
      // Ensure each item has name, image, price, quantity
      let computedTotal = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.drinkId) return res.status(400).json({ message: `Item ${i} missing drinkId` });

        if (!it.name || !it.image || typeof it.price !== "number") {
          const product = await Drink.findById(it.drinkId);
          if (!product) return res.status(404).json({ message: `Product ${it.drinkId} not found` });

          items[i].name = items[i].name || product.name;
          items[i].image = items[i].image || product.image || product.imageUrl || "";

          if (typeof items[i].price !== "number" || items[i].price === 0) {
            const selectedPack =
              product.packs?.find((p) => String(p.pack) === String(items[i].pack)) || product.packs?.[0];
            items[i].price = selectedPack?.price || 0;
          }
        }
        items[i].quantity = items[i].quantity || 1;
        computedTotal += items[i].price * items[i].quantity;
      }
      if (!bodyTotal) totalAmount = computedTotal;
    } else {
      // Build from server-side cart
      const cartItems = await Cart.find({ userId }).populate("drinkId");
      if (!cartItems.length) return res.status(404).json({ message: "Cart is empty" });

      items = cartItems.map((ci) => {
        const product = ci.drinkId;
        const selectedPack =
          product.packs?.find((p) => String(p.pack) === String(ci.pack)) || product.packs?.[0];
        const price = selectedPack?.price || 0;
        totalAmount += price * ci.quantity;
        return {
          drinkId: product._id,
          name: product.name,
          image: product.image || product.imageUrl || "",
          pack: selectedPack?.pack || null,
          price,
          quantity: ci.quantity,
        };
      });
    }

    if (!items.length) return res.status(400).json({ message: "No items to create order" });
    if (!totalAmount || totalAmount <= 0) return res.status(400).json({ message: "Invalid total amount" });

    // Prevent duplicate order
    let existing = await Order.findOne({ paystackReference: reference });
    if (existing) return res.status(200).json({ success: true, message: "Order already exists", order: existing });

    // Generate order number
    const orderNumber = await getNextOrderNumber();
    const parsedDeliveryDate = deliveryDate ? new Date(deliveryDate) : null;

    const order = await Order.create({
      userId,
      customer,
      deliveryDate: parsedDeliveryDate,
      deliveryTime: deliveryTime || null,
      items,
      totalAmount,
      paystackReference: reference,
      paymentStatus: "pending",
      orderStatus: "confirmed",
      orderNumber,
      vendor: vendor || "",
    });

    // Notify customer
    if (customer?.email) {
      try {
        await sendEmail({
          to: customer.email,
          subject: `Order Received — ${orderNumber}`,
          html: `<p>Hi ${customer.fullName || "Customer"},</p>
                 <p>Your order <strong>${orderNumber}</strong> is received.</p>
                 <p><strong>Items:</strong></p>
                 <ul>${items.map(i => `<li>${i.quantity} × ${i.name} (${i.pack ?? ""}) — ₵${i.price}</li>`).join("")}</ul>
                 <p><strong>Total:</strong> ₵${totalAmount}</p>
                 ${parsedDeliveryDate ? `<p><strong>Delivery:</strong> ${parsedDeliveryDate.toISOString().slice(0,10)} ${deliveryTime ? "at " + deliveryTime : ""}</p>` : ""}
                 <p>We will notify you when payment is confirmed and your order is being prepared.</p>`,
        });
      } catch (err) {
        console.warn("Customer email failed:", err.message);
      }
    }

    // Notify admin
    if (process.env.ADMIN_EMAIL) {
      try {
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: `New Order — ${orderNumber}`,
          html: `<p>New order <strong>${orderNumber}</strong> placed by ${customer.fullName || userId}</p>
                 <p>Total: ₵${totalAmount}</p>`,
        });
      } catch (err) {
        console.warn("Admin email failed:", err.message);
      }
    }

    // Clear cart
    try {
      await Cart.deleteMany({ userId });
    } catch (err) {
      console.warn("Failed to clear cart:", err.message);
    }

    res.status(201).json({ success: true, order });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ message: "Failed to create order", error: err.message });
  }
};

/* ----------------- Paystack Webhook ----------------- */
export const webhookPayment = async (req, res) => {
  try {
    const { event, data } = req.body;
    if (event !== "charge.success") return res.status(200).send("Ignored");

    const { reference, metadata, amount } = data;
    const { cart, customer: rawCustomer, deliveryDate, deliveryTime, userId, vendor } = metadata || {};

    if (!cart || !userId) return res.status(400).send("Missing metadata");

    const items = await Promise.all(
      cart.map(async (item) => {
        if (!item.name || !item.image || typeof item.price !== "number") {
          const product = await Drink.findById(item.drinkId);
          return {
            drinkId: item.drinkId,
            image: item.image || product?.image || product?.imageUrl || "",
            name: item.name || product?.name || "Unknown product",
            pack: item.pack || null,
            price: typeof item.price === "number" ? item.price : product?.packs?.[0]?.price || 0,
            quantity: item.quantity || 1,
          };
        }
        return {
          drinkId: item.drinkId,
          image: item.image || "",
          name: item.name,
          pack: item.pack || null,
          price: item.price,
          quantity: item.quantity || 1,
        };
      })
    );

    const totalAmount = (amount || 0) / 100;
    let order = await Order.findOne({ paystackReference: reference });

    if (!order) {
      const customer = sanitizeCustomer(rawCustomer || {});
      const orderNumber = await getNextOrderNumber();
      const parsedDeliveryDate = deliveryDate ? new Date(deliveryDate) : null;

      order = await Order.create({
        userId,
        customer,
        deliveryDate: parsedDeliveryDate,
        deliveryTime: deliveryTime || null,
        items,
        totalAmount,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
        orderNumber,
        vendor: vendor || "",
      });

      // Customer email
      if (customer.email) {
        try {
          await sendEmail({
            to: customer.email,
            subject: `Order Confirmed — ${orderNumber}`,
            html: `<p>Hi ${customer.fullName || ""},</p>
                   <p>Your order <strong>${orderNumber}</strong> is confirmed.</p>
                   <ul>${items.map(i => `<li>${i.quantity} × ${i.name} (${i.pack ?? ""}) — ₵${i.price}</li>`).join("")}</ul>
                   <p>Total: ₵${totalAmount}</p>`,
          });
        } catch (err) {
          console.warn("Customer email failed:", err.message);
        }
      }

      // Admin email
      if (process.env.ADMIN_EMAIL) {
        try {
          await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: `New Order — ${orderNumber}`,
            html: `<p>New order <strong>${orderNumber}</strong> by ${customer.fullName || userId}</p>
                   <p>Total: ₵${totalAmount}</p>`,
          });
        } catch (err) {
          console.warn("Admin email failed:", err.message);
        }
      }
    }

    // Clear cart
    try {
      await Cart.deleteMany({ userId });
    } catch (err) {
      console.warn("Failed to clear user's cart:", err.message);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).send("Webhook failed");
  }
};
