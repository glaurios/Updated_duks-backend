// ------------------ FIXED PAYMENT CONTROLLER ------------------

import axios from "axios";
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import User from "../models/user.js";
import { sendEmail } from "../utils/Email.js";

// 1️⃣ Initialize Payment
export const initializePayment = async (req, res) => {
  try {
    const { email: checkoutEmail, phone, provider, fullName, address } = req.body;
    const userEmail = checkoutEmail || req.user.email;

    // Fetch cart items
    const cartItems = await Cart.find({ userId: req.user._id }).populate({
      path: "drinkId",
      strictPopulate: false,
    });

    if (!cartItems || cartItems.length === 0)
      return res.status(400).json({ message: "Cart is empty" });

    const validItems = cartItems.filter(item => item.drinkId);
    if (validItems.length === 0)
      return res.status(400).json({ message: "No valid drinks in cart" });

    let total = 0;
    const items = validItems.map(item => {
      const price = item.drinkId.packs?.[0]?.price || 0;
      total += price * item.quantity;
      return {
        drinkId: item.drinkId._id,
        name: item.drinkId.name,
        price,
        quantity: item.quantity,
        pack: item.pack,
        image: item.drinkId.imageUrl || item.drinkId.image || "",
      };
    });

    const amount = total * 100;

    const paystackData = {
      email: userEmail,
      amount,
      currency: "GHS",
      callback_url: `${process.env.FRONTEND_URL}/orders`,
      metadata: {
        userId: req.user._id,
        email: userEmail,
        fullName: fullName || req.user.fullName || "Customer",
        phone: phone || req.user.phone || "",
        address: address || req.user.address || "",
        provider: provider || "",
        items,
      },
    };

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
    console.error("Payment init error:", error.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
};

// 2️⃣ Webhook receives payment success
export const webhookPayment = async (req, res) => {
  try {
    console.log("💥 Paystack Webhook received:", new Date().toISOString());
    const { event, data } = req.body;

    if (event === "charge.success") {
      const { reference, metadata, amount } = data;
      const { userId, fullName, phone, email, address } = metadata;
      const totalAmount = amount / 100;

      // fallback if metadata fields missing
      const user = await User.findById(userId);
      const finalEmail = email || user?.email || "";
      const finalPhone = phone || user?.phone || "";
      const finalAddress = address || user?.address || "";

      let order = await Order.findOne({ paystackReference: reference });
      if (!order) {
        order = await Order.create({
          userId,
          items: metadata.items,
          totalAmount,
          paystackReference: reference,
          paymentStatus: "paid",
          orderStatus: "confirmed",
          customer: {
            fullName: fullName || "Customer",
            email: finalEmail,
            phone: finalPhone,
            address: finalAddress,
          },
        });
        console.log(`✅ Order created: ${reference}`);

        // ... (rest of your email sending code remains exactly the same)
      } else {
        console.log(`⚠️ Order already exists for reference ${reference}`);
      }

      await Cart.deleteMany({ userId });
      console.log(`🧹 Cart cleared for user ${userId}`);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Server error");
  }
};

// 3️⃣ Verify Payment
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

    const { userId, fullName, phone, email, address } = data.metadata;
    const totalAmount = data.amount / 100;

    const user = await User.findById(userId);
    const finalEmail = email || user?.email || "";
    const finalPhone = phone || user?.phone || "";
    const finalAddress = address || user?.address || "";

    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items: data.metadata.items,
        totalAmount,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
        customer: {
          fullName: fullName || "Customer",
          email: finalEmail,
          phone: finalPhone,
          address: finalAddress,
        },
      });

      // ... (rest of your email sending code remains exactly the same)

      await Cart.deleteMany({ userId });
      console.log(`✅ Order created on backend verify: ${reference}`);
    }

    return res.redirect(`${process.env.FRONTEND_URL}/orders`);
  } catch (error) {
    console.error("Payment verification error:", error.response?.data || error.message);
    res.status(500).json({ message: "Payment verification failed" });
  }
};
