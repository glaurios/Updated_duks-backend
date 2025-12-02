import axios from "axios";
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import Drink from "../models/drink.js";
import { sendEmail } from "../utils/Email.js";

// ---------------- 1️⃣ Initialize Payment ----------------
export const initializePayment = async (req, res) => {
  try {
    const {
      email: checkoutEmail,
      phone,
      provider,
      fullName,
      address,
      city = "",
      country = "Ghana",
    } = req.body;

    const userEmail = checkoutEmail || req.user.email;

    // fetch authoritative cart
    const cartItems = await Cart.find({ userId: req.user._id }).populate({
      path: "drinkId",
      strictPopulate: false,
    });

    if (!cartItems || cartItems.length === 0)
      return res.status(400).json({ message: "Cart is empty" });

    const validItems = cartItems.filter(item => item.drinkId);
    if (!validItems.length)
      return res.status(400).json({ message: "No valid drinks in cart" });

    let total = 0;

    const items = validItems.map(item => {
      const product = item.drinkId;
      const packsArr = Array.isArray(product.packs) ? product.packs : [];

      // case-insensitive pack matching
      const selectedPackObj =
        packsArr.find(
          p => String(p.pack).toLowerCase() === String(item.pack).toLowerCase()
        ) || null;

      // always take DB price, ignore item.price
      const price = selectedPackObj?.price ?? product.price ?? 0;
      total += price * Number(item.quantity || 1);

      return {
        drinkId: product._id,
        name: product.name,
        price,
        quantity: Number(item.quantity || 1),
        pack: item.pack,
        image: product.imageUrl || product.image || "",
      };
    });

    const amount = Math.round(total * 100); // Paystack expects lowest denom

    const customer = {
      fullName: fullName || req.user.fullName || "Customer",
      email: userEmail,
      phone: phone || req.user.phone || "",
      address: address || req.user.address || "",
      city: city || req.user.city || "",
      country: country || req.user.country || "Ghana",
    };

    const paystackData = {
      email: userEmail,
      amount,
      currency: "GHS",
      callback_url: `${process.env.FRONTEND_URL}/orders`,
      metadata: {
        userId: req.user._id,
        customer,
        items,
        email: userEmail,
        fullName: customer.fullName,
        phone: customer.phone,
        address: customer.address,
        provider: provider || "",
      },
    };

    console.log("💰 Payment initialized metadata:", JSON.stringify(paystackData.metadata, null, 2));

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      paystackData,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    res.json({
      success: true,
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (error) {
    console.error("Payment init error:", error.message, error.stack);
    res.status(500).json({ error: "Payment initialization failed" });
  }
};

// ---------------- 2️⃣ Webhook Payment ----------------
export const webhookPayment = async (req, res) => {
  try {
    console.log("💥 Paystack Webhook received:", new Date().toISOString());
    const { event, data } = req.body;

    if (event !== "charge.success") {
      console.log(`Ignoring event: ${event}`);
      return res.status(200).send("Event ignored");
    }

    const { reference, metadata, amount, customer: paystackCustomer } = data;
    const itemsRaw = metadata?.items || [];
    const userId = metadata?.userId;

    if (!userId) return res.status(400).send("Missing userId");
    if (!itemsRaw.length) return res.status(400).send("No items in order");

    // rebuild items with DB price
    const items = await Promise.all(
      itemsRaw.map(async item => {
        const product = await Drink.findById(item.drinkId);
        if (!product) return item; // fallback if product deleted

        const packObj =
          product.packs?.find(p => String(p.pack).toLowerCase() === String(item.pack).toLowerCase()) || null;
        const price = packObj?.price ?? product.price ?? 0;

        return {
          drinkId: item.drinkId,
          name: item.name || product.name,
          price,
          quantity: item.quantity || 1,
          pack: item.pack || null,
          image: item.image || product.image || product.imageUrl || "",
        };
      })
    );

    const customerFromMetadata = metadata?.customer || {};
    const customerFromOldFormat = {
      fullName: metadata?.fullName,
      email: metadata?.email,
      phone: metadata?.phone,
      address: metadata?.address,
      city: metadata?.city,
      country: metadata?.country,
    };
    const customer = {
      fullName: customerFromMetadata.fullName || customerFromOldFormat.fullName || paystackCustomer?.first_name + " " + paystackCustomer?.last_name || "Customer",
      email: customerFromMetadata.email || customerFromOldFormat.email || paystackCustomer?.email || "",
      phone: customerFromMetadata.phone || customerFromOldFormat.phone || paystackCustomer?.phone || "",
      address: customerFromMetadata.address || customerFromOldFormat.address || paystackCustomer?.metadata?.address || "Not provided",
      city: customerFromMetadata.city || customerFromOldFormat.city || paystackCustomer?.metadata?.city || "",
      country: customerFromMetadata.country || customerFromOldFormat.country || paystackCustomer?.metadata?.country || "Ghana"
    };

    const totalAmount = amount / 100;

    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items,
        totalAmount,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
        customer,
      });

      // send emails
      if (customer.email) {
        try {
          await sendEmail({
            to: customer.email,
            subject: "Your Order is Confirmed ✅",
            html: `<p>Hi ${customer.fullName}, your order ${order._id} is confirmed. Total: ₵${totalAmount}</p>`,
          });
        } catch (err) { console.warn("Email failed:", err.message); }
      }
      if (process.env.ADMIN_EMAIL) {
        try {
          await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: "New Order Received 🛒",
            html: `<p>Order ID: ${order._id}, Customer: ${customer.fullName}, Total: ₵${totalAmount}</p>`,
          });
        } catch (err) { console.warn("Admin email failed:", err.message); }
      }
    }

    // clear cart
    try { await Cart.deleteMany({ userId }); } 
    catch (err) { console.warn("Failed to clear cart:", err.message); }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook error:", error.message, error.stack);
    res.status(500).send("Server error");
  }
};

// ---------------- 3️⃣ Verify Payment ----------------
export const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    const data = response.data.data;
    if (data.status !== "success")
      return res.status(400).json({ message: "Payment failed" });

    const metadata = data.metadata || {};
    const userId = metadata.userId;
    const itemsRaw = metadata.items || [];

    // rebuild items with DB price
    const items = await Promise.all(
      itemsRaw.map(async item => {
        const product = await Drink.findById(item.drinkId);
        if (!product) return item;

        const packObj =
          product.packs?.find(p => String(p.pack).toLowerCase() === String(item.pack).toLowerCase()) || null;
        const price = packObj?.price ?? product.price ?? 0;

        return {
          drinkId: item.drinkId,
          name: item.name || product.name,
          price,
          quantity: item.quantity || 1,
          pack: item.pack || null,
          image: item.image || product.image || product.imageUrl || "",
        };
      })
    );

    const customerFromMetadata = metadata?.customer || {};
    const customerFromOldFormat = {
      fullName: metadata?.fullName,
      email: metadata?.email,
      phone: metadata?.phone,
      address: metadata?.address,
      city: metadata?.city,
      country: metadata?.country,
    };
    const customer = {
      fullName: customerFromMetadata.fullName || customerFromOldFormat.fullName || "Customer",
      email: customerFromMetadata.email || customerFromOldFormat.email || "",
      phone: customerFromMetadata.phone || customerFromOldFormat.phone || "",
      address: customerFromMetadata.address || customerFromOldFormat.address || "Not provided",
      city: customerFromMetadata.city || customerFromOldFormat.city || "",
      country: customerFromMetadata.country || customerFromOldFormat.country || "Ghana"
    };

    const totalAmount = data.amount / 100;

    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items,
        totalAmount,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
        customer,
      });

      await Cart.deleteMany({ userId });

      if (customer.email) {
        try {
          await sendEmail({
            to: customer.email,
            subject: "Your Order is Confirmed ✅",
            html: `<p>Hi ${customer.fullName}, your order ${order._id} has been confirmed. Total: ₵${totalAmount}</p>`,
          });
        } catch (err) { console.warn("Email failed:", err.message); }
      }
    }

    return res.redirect(`${process.env.FRONTEND_URL}/orders`);
  } catch (error) {
    console.error("Payment verification error:", error.response?.data || error.message);
    res.status(500).json({ message: "Payment verification failed" });
  }
};
