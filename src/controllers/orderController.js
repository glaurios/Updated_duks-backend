// controllers/orderController.js
import axios from "axios";
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import User from "../models/user.js";
import { sendEmail } from "../utils/Email.js";

/**
 * Consolidated order controller:
 * - getAllOrders
 * - getUserOrders
 * - getOrderById
 * - updateOrderStatus
 * - cancelOrder
 * - getOrderStats
 * - createOrderFromCheckout (manual POST after verifying payment)
 * - initializePayment (Paystack initialize)
 * - webhookPayment (Paystack webhook handler)
 * - verifyPayment (server-side Paystack verify + create order + clear cart + redirect)
 *
 * Notes:
 * - All Order creation checks for existing paystackReference to avoid duplicates.
 * - metadata from Paystack can sometimes be a JSON-string; we attempt to parse safely.
 * - After creating an order we clear the cart for that user.
 * - verifyPayment redirects to FRONTEND_URL/orders (same behavior as your previous code).
 */

/* -----------------------------
   Admin & User routes
   ----------------------------- */

export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).populate("userId", "email name");
    return res.json({ orders });
  } catch (err) {
    console.error("getAllOrders error:", err);
    return res.status(500).json({ message: "Failed to fetch orders" });
  }
};

export const getUserOrders = async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 });
    // If you only want paid orders: add { paymentStatus: "paid" } to the query
    return res.json({ orders });
  } catch (err) {
    console.error("getUserOrders error:", err);
    return res.status(500).json({ message: "Failed to fetch user orders" });
  }
};

export const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id).populate("userId", "email name");
    if (!order) return res.status(404).json({ message: "Order not found" });
    return res.json({ order });
  } catch (err) {
    console.error("getOrderById error:", err);
    return res.status(500).json({ message: "Failed to fetch order" });
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { orderStatus } = req.body;

    const order = await Order.findByIdAndUpdate(id, { orderStatus }, { new: true }).populate(
      "userId",
      "email name"
    );
    if (!order) return res.status(404).json({ message: "Order not found" });

    // email if completed
    if (orderStatus === "completed" && order.userId?.email) {
      try {
        await sendEmail({
          to: order.userId.email,
          subject: "Order Completed ✅",
          html: `<p>Your order <b>${order._id}</b> has been completed/delivered. Thank you for shopping with us!</p>`,
        });
      } catch (mailErr) {
        console.error("Failed sending completion email:", mailErr);
      }
    }

    return res.json({ message: "Order status updated", order });
  } catch (err) {
    console.error("updateOrderStatus error:", err);
    return res.status(500).json({ message: "Failed to update order status" });
  }
};

export const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findByIdAndUpdate(
      id,
      { orderStatus: "cancelled", paymentStatus: "refunded" },
      { new: true }
    ).populate("userId", "email name");

    if (!order) return res.status(404).json({ message: "Order not found" });

    // notify user
    try {
      await sendEmail({
        to: order.userId.email,
        subject: "Order Cancelled ❌",
        html: `<p>Your order <b>${order._id}</b> has been cancelled. Payment has been refunded if applicable.</p>`,
      });
    } catch (mailErr) {
      console.error("Failed sending cancel email:", mailErr);
    }

    return res.json({ message: "Order cancelled", order });
  } catch (err) {
    console.error("cancelOrder error:", err);
    return res.status(500).json({ message: "Failed to cancel order" });
  }
};

export const getOrderStats = async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const totalRevenueAgg = await Order.aggregate([
      { $match: { paymentStatus: "paid" } },
      { $group: { _id: null, totalRevenue: { $sum: "$totalAmount" } } },
    ]);
    const totalRevenue = totalRevenueAgg[0]?.totalRevenue || 0;
    return res.json({ totalOrders, totalRevenue });
  } catch (err) {
    console.error("getOrderStats error:", err);
    return res.status(500).json({ message: "Failed to fetch stats" });
  }
};

/* -----------------------------
   Create order from checkout (manual)
   This is useful if the frontend verifies the payment and then POSTs { reference } here
   ----------------------------- */

export const createOrderFromCheckout = async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ message: "Missing payment reference" });

    const userId = req.user._id;

    // Get cart items (assuming Cart documents for user contain items array)
    const cartItems = await Cart.find({ userId }).populate("drinkId");
    if (!cartItems || cartItems.length === 0) return res.status(404).json({ message: "Cart is empty" });

    // build items and total
    let totalAmount = 0;
    const items = cartItems.flatMap((cartDoc) =>
      (cartDoc.items || []).map((item) => {
        const price = item.drinkId?.packs?.[0]?.price ?? 0;
        totalAmount += price * (item.quantity || 0);
        return {
          drinkId: item.drinkId ? item.drinkId._id : item.drinkId,
          name: item.drinkId?.name ?? item.name,
          price,
          quantity: item.quantity,
        };
      })
    );

    // avoid duplicate orders
    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items,
        totalAmount,
        paymentStatus: "paid",
        orderStatus: "confirmed",
        paystackReference: reference,
      });

      // emails
      try {
        await sendEmail({
          to: req.user.email,
          subject: "Order Confirmed ✅",
          html: `<p>Your order <b>${reference}</b> has been successfully placed and confirmed.</p><p>Total Amount: GHS ${totalAmount}</p>`,
        });
      } catch (mailErr) {
        console.error("createOrderFromCheckout: customer email failed", mailErr);
      }

      if (process.env.ADMIN_EMAIL) {
        try {
          await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: "New Order Placed 🛒",
            html: `<p>New order <b>${reference}</b> has been placed by ${req.user.email}.</p><p>Total Amount: GHS ${totalAmount}</p>`,
          });
        } catch (mailErr) {
          console.error("createOrderFromCheckout: admin email failed", mailErr);
        }
      }
    } else {
      console.log("createOrderFromCheckout: order already exists for reference", reference);
    }

    // Clear cart(s)
    try {
      await Cart.deleteMany({ userId });
    } catch (cartErr) {
      console.error("Failed to clear cart after createOrderFromCheckout:", cartErr);
    }

    return res.status(201).json({ success: true, order });
  } catch (err) {
    console.error("createOrderFromCheckout error:", err);
    return res.status(500).json({ message: "Failed to create order" });
  }
};

/* -----------------------------
   Paystack Integration
   - initializePayment: call Paystack initialize (returns authorization_url + reference)
   - webhookPayment: receives Paystack webhooks (idempotent, creates order if not exists)
   - verifyPayment: server-side verify endpoint that queries Paystack verify and creates order if needed
   ----------------------------- */

/**
 * Initialize a Paystack transaction using the user's cart
 */
export const initializePayment = async (req, res) => {
  try {
    const { email: checkoutEmail, phone, fullName } = req.body;
    const userEmail = checkoutEmail || req.user.email;

    const cart = await Cart.findOne({ userId: req.user._id }).populate("items.drinkId");
    if (!cart || !cart.items || cart.items.length === 0) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    let total = 0;
    const items = cart.items.map((item) => {
      const price = item.drinkId?.packs?.[0]?.price ?? 0;
      total += price * (item.quantity || 0);
      return {
        drinkId: item.drinkId?._id,
        name: item.drinkId?.name,
        price,
        quantity: item.quantity,
      };
    });

    const amount = Math.round(total * 100); // smallest currency unit

    const metadata = {
      userId: req.user._id,
      email: userEmail,
      fullName: fullName || req.user.fullName || "Customer",
      phone: phone || "",
      items,
    };

    const paystackData = {
      email: userEmail,
      amount,
      currency: "GHS",
      callback_url: `${process.env.FRONTEND_URL}/orders`,
      metadata,
    };

    const response = await axios.post("https://api.paystack.co/transaction/initialize", paystackData, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });

    const respData = response.data?.data || {};
    return res.json({
      success: true,
      authorization_url: respData.authorization_url,
      reference: respData.reference,
    });
  } catch (error) {
    console.error("initializePayment error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Payment initialization failed" });
  }
};

/**
 * Webhook handler for Paystack events (idempotent)
 * Make sure your webhook route is configured on Paystack dashboard and that you verify signature if needed.
 */
export const webhookPayment = async (req, res) => {
  try {
    console.log("Paystack webhook payload:", req.body);

    const { event, data } = req.body;
    if (!event || !data) {
      return res.status(400).send("Bad webhook payload");
    }

    // Only handle successful charges
    if (event === "charge.success") {
      const reference = data.reference;
      // metadata may be stringified; ensure it's an object
      let metadata = data.metadata ?? {};
      if (typeof metadata === "string") {
        try {
          metadata = JSON.parse(metadata);
        } catch (e) {
          // keep as-is
        }
      }

      const items = metadata.items || metadata.cart || metadata.orderItems || [];
      const userId = metadata.userId || metadata.user || metadata.customerId;
      const amount = data.amount ?? data.total ?? 0;
      const totalAmount = amount / 100;

      if (!userId) {
        console.warn("webhookPayment: missing userId in metadata — cannot clear cart reliably");
      }

      // Prevent duplicates
      let order = await Order.findOne({ paystackReference: reference });
      if (!order) {
        order = await Order.create({
          userId,
          items,
          totalAmount,
          paystackReference: reference,
          paymentStatus: "paid",
          orderStatus: "confirmed",
        });

        // send notification emails
        const itemsHtml = (Array.isArray(items) ? items : []).map(
          (it) => `<tr><td>${it.name}</td><td style="text-align:center">${it.quantity}</td><td style="text-align:right">GHS ${it.price}</td></tr>`
        ).join("");

        try {
          if (metadata.email) {
            await sendEmail({
              to: metadata.email,
              subject: "Order Confirmed ✅",
              html: `<h3>Your order ${reference} is confirmed</h3><table>${itemsHtml}</table><p>Total: GHS ${totalAmount}</p>`,
            });
          } else if (userId) {
            const user = await User.findById(userId);
            if (user?.email) {
              await sendEmail({
                to: user.email,
                subject: "Order Confirmed ✅",
                html: `<h3>Your order ${reference} is confirmed</h3><table>${itemsHtml}</table><p>Total: GHS ${totalAmount}</p>`,
              });
            }
          }
        } catch (mailErr) {
          console.error("webhookPayment: customer email failed", mailErr);
        }

        if (process.env.ADMIN_EMAIL) {
          try {
            await sendEmail({
              to: process.env.ADMIN_EMAIL,
              subject: "New Order Received 🛒",
              html: `<p>Order ${reference} placed. Total: GHS ${totalAmount}</p><table>${itemsHtml}</table>`,
            });
          } catch (adminMailErr) {
            console.error("webhookPayment: admin email failed", adminMailErr);
          }
        }
      } else {
        console.log("webhookPayment: order already exists for reference", reference);
      }

      // Clear the user's cart(s)
      try {
        if (userId) {
          // if you store one Cart document per user:
          await Cart.findOneAndUpdate({ userId }, { items: [] });
          // if you use multiple cart docs or separate line items, you might use deleteMany
          // await Cart.deleteMany({ userId });
          console.log("Cart cleared for user", userId);
        }
      } catch (cartErr) {
        console.error("webhookPayment: failed to clear cart", cartErr);
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("webhookPayment error:", err);
    return res.status(500).send("Server error");
  }
};

/**
 * verifyPayment
 * - Verifies a Paystack transaction server-side.
 * - Creates order if not exists and clears cart for that user.
 * - Then redirects user to FRONTEND_URL/orders (matching prior behavior).
 */
export const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;
    if (!reference) return res.status(400).json({ message: "Missing reference param" });

    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });

    const data = response.data?.data;
    if (!data) {
      console.error("verifyPayment: unexpected verify response", response.data);
      return res.status(500).json({ message: "Invalid verification response" });
    }

    if (data.status !== "success") {
      return res.status(400).json({ message: "Payment not successful" });
    }

    // metadata safety: parse if string
    let metadata = data.metadata ?? {};
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch (e) {
        // keep as-is
      }
    }

    const userId = metadata.userId ?? metadata.user ?? metadata.customerId;
    const items = metadata.items ?? metadata.cart ?? [];
    const amount = data.amount ?? 0;
    const totalAmount = amount / 100;
    let email = metadata.email || (userId ? (await User.findById(userId)).email : undefined);

    // avoid duplicate creation
    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items,
        totalAmount,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
      });

      // send emails (best-effort)
      const itemsHtml = (Array.isArray(items) ? items : []).map(
        (it) => `<tr><td>${it.name}</td><td style="text-align:center">${it.quantity}</td><td style="text-align:right">GHS ${it.price}</td></tr>`
      ).join("");

      try {
        if (email) {
          await sendEmail({
            to: email,
            subject: "Your Duk's Juices Order is Confirmed ✅",
            html: `<h3>Your order ${reference} is confirmed</h3><table>${itemsHtml}</table><p>Total: GHS ${totalAmount}</p>`,
          });
        }
      } catch (mailErr) {
        console.error("verifyPayment: customer email failed", mailErr);
      }

      if (process.env.ADMIN_EMAIL) {
        try {
          await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: "New Duk's Juices Order Received 🛒",
            html: `<p>Order ${reference} placed. Total: GHS ${totalAmount}</p><table>${itemsHtml}</table>`,
          });
        } catch (adminMailErr) {
          console.error("verifyPayment: admin email failed", adminMailErr);
        }
      }
    } else {
      console.log("verifyPayment: order already exists for reference", reference);
    }

    // Clear cart for user if possible
    try {
      if (userId) {
        await Cart.findOneAndUpdate({ userId }, { items: [] });
      }
    } catch (cartErr) {
      console.error("verifyPayment: failed to clear cart", cartErr);
    }

    // Redirect the user to frontend orders page (keeps previous behavior)
    const redirectTo = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/orders` : "/orders";
    return res.redirect(redirectTo);
  } catch (error) {
    console.error("verifyPayment error:", error.response?.data || error.message);
    return res.status(500).json({ message: "Payment verification failed" });
  }
};
