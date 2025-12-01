import axios from "axios";
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import User from "../models/user.js";
import { sendEmail } from "../utils/Email.js";

// 1️⃣ Initialize Payment
export const initializePayment = async (req, res) => {
  try {
    const { email: checkoutEmail, phone, provider, fullName } = req.body; // capture email, phone, provider, fullName
    const userEmail = checkoutEmail || req.user.email;

    const cart = await Cart.findOne({ userId: req.user._id }).populate("items.drinkId");
    if (!cart || cart.items.length === 0)
      return res.status(400).json({ message: "Cart is empty" });

    let total = 0;
    const items = cart.items.map(item => {
      const price = item.drinkId.packs?.[0]?.price || 0;
      total += price * item.quantity;
      return {
        drinkId: item.drinkId._id,
        name: item.drinkId.name,
        price,
        quantity: item.quantity,
      };
    });

    const amount = total * 100; // Paystack expects kobo

    const paystackData = {
      email: userEmail,
      amount,
      currency: "GHS",
      callback_url: `${process.env.FRONTEND_URL}/orders`,
      metadata: {
        userId: req.user._id,
        email: userEmail,
        fullName: fullName || req.user.fullName || "Customer",
        phone: phone || "",
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
      const { userId, fullName } = metadata;
      let email = metadata.email;
      const totalAmount = amount / 100;

      // fallback: fetch email from DB if missing
      if (!email) {
        const user = await User.findById(userId);
        email = user?.email;
      }

      let order = await Order.findOne({ paystackReference: reference });
      if (!order) {
        order = await Order.create({
          userId,
          items: metadata.items,
          totalAmount,
          paystackReference: reference,
          paymentStatus: "paid",
          orderStatus: "confirmed",
        });
        console.log(`✅ Order created: ${reference}`);

        // ✅ Professional email to customer
        if (email) {
          const itemsHtml = metadata.items.map(
            item => `<tr>
                       <td style="padding:8px;border:1px solid #ddd;">${item.name}</td>
                       <td style="padding:8px;border:1px solid #ddd;text-align:center;">${item.quantity}</td>
                       <td style="padding:8px;border:1px solid #ddd;text-align:right;">GHS ${item.price}</td>
                     </tr>`
          ).join("");

          await sendEmail({
            to: email,
            subject: "Your Duk's Juices Order is Confirmed ✅",
            html: `
              <div style="font-family: Arial, sans-serif; max-width:600px; margin:auto; border:1px solid #eee; border-radius:8px; overflow:hidden;">
                <div style="background-color:#FF6F00; color:white; padding:20px; text-align:center;">
                  <h1>Duk's Juices</h1>
                  <p style="margin:0;">Order Confirmation</p>
                </div>
                <div style="padding:20px;">
                  <h2>Hi ${fullName || "Customer"},</h2>
                  <p>Thank you for shopping with <strong>Duk's Juices</strong>! Your order <strong>${reference}</strong> has been successfully confirmed.</p>
                  <h3>Order Details:</h3>
                  <table style="width:100%; border-collapse:collapse; margin-top:10px;">
                    <thead>
                      <tr style="background-color:#f7f7f7;">
                        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Item</th>
                        <th style="padding:8px;border:1px solid #ddd;text-align:center;">Quantity</th>
                        <th style="padding:8px;border:1px solid #ddd;text-align:right;">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${itemsHtml}
                    </tbody>
                  </table>
                  <p style="margin-top:15px; font-weight:bold; text-align:right;">Total: GHS ${totalAmount}</p>
                  <p style="margin-top:20px;">We appreciate your business and hope you enjoy your drinks!</p>
                  <p>Cheers,<br>Duk's Juices Team 🍹</p>
                </div>
              </div>
            `,
          });
        }

        // ✅ Admin notification email
        if (process.env.ADMIN_EMAIL) {
          const itemsHtml = metadata.items.map(
            item => `<tr>
                       <td style="padding:8px;border:1px solid #ddd;">${item.name}</td>
                       <td style="padding:8px;border:1px solid #ddd;text-align:center;">${item.quantity}</td>
                       <td style="padding:8px;border:1px solid #ddd;text-align:right;">GHS ${item.price}</td>
                     </tr>`
          ).join("");

          await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: "New Duk's Juices Order Received 🛒",
            html: `
              <div style="font-family: Arial, sans-serif; max-width:600px; margin:auto; border:1px solid #eee; border-radius:8px; overflow:hidden;">
                <div style="background-color:#1976D2; color:white; padding:20px; text-align:center;">
                  <h1>New Order Received</h1>
                </div>
                <div style="padding:20px;">
                  <p>Order <strong>${reference}</strong> has been placed by ${fullName || "a customer"}.</p>
                  <h3>Order Details:</h3>
                  <table style="width:100%; border-collapse:collapse; margin-top:10px;">
                    <thead>
                      <tr style="background-color:#f7f7f7;">
                        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Item</th>
                        <th style="padding:8px;border:1px solid #ddd;text-align:center;">Quantity</th>
                        <th style="padding:8px;border:1px solid #ddd;text-align:right;">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${itemsHtml}
                    </tbody>
                  </table>
                  <p style="margin-top:15px; font-weight:bold; text-align:right;">Total: GHS ${totalAmount}</p>
                </div>
              </div>
            `,
          });
        }
      } else {
        console.log(`⚠️ Order already exists for reference ${reference}`);
      }

      await Cart.findOneAndUpdate({ userId }, { items: [] });
      console.log(`🧹 Cart cleared for user ${userId}`);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Server error");
  }
};

// 3️⃣ Verify Payment (safety check)
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

    const { userId, fullName } = data.metadata;
    let email = data.metadata.email;
    const totalAmount = data.amount / 100;

    if (!email) {
      const user = await User.findById(userId);
      email = user?.email;
    }

    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items: data.metadata.items,
        totalAmount,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
      });

      // send customer email
      if (email) {
        const itemsHtml = data.metadata.items.map(
          item => `<tr>
                     <td style="padding:8px;border:1px solid #ddd;">${item.name}</td>
                     <td style="padding:8px;border:1px solid #ddd;text-align:center;">${item.quantity}</td>
                     <td style="padding:8px;border:1px solid #ddd;text-align:right;">GHS ${item.price}</td>
                   </tr>`
        ).join("");

        await sendEmail({
          to: email,
          subject: "Your Duk's Juices Order is Confirmed ✅",
          html: `
            <div style="font-family: Arial, sans-serif; max-width:600px; margin:auto; border:1px solid #eee; border-radius:8px; overflow:hidden;">
              <div style="background-color:#FF6F00; color:white; padding:20px; text-align:center;">
                <h1>Duk's Juices</h1>
                <p style="margin:0;">Order Confirmation</p>
              </div>
              <div style="padding:20px;">
                <h2>Hi ${fullName || "Customer"},</h2>
                <p>Thank you for shopping with <strong>Duk's Juices</strong>! Your order <strong>${reference}</strong> has been successfully confirmed.</p>
                <h3>Order Details:</h3>
                <table style="width:100%; border-collapse:collapse; margin-top:10px;">
                  <thead>
                    <tr style="background-color:#f7f7f7;">
                      <th style="padding:8px;border:1px solid #ddd;text-align:left;">Item</th>
                      <th style="padding:8px;border:1px solid #ddd;text-align:center;">Quantity</th>
                      <th style="padding:8px;border:1px solid #ddd;text-align:right;">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${itemsHtml}
                  </tbody>
                </table>
                <p style="margin-top:15px; font-weight:bold; text-align:right;">Total: GHS ${totalAmount}</p>
                <p style="margin-top:20px;">We appreciate your business and hope you enjoy your drinks!</p>
                <p>Cheers,<br>Duk's Juices Team 🍹</p>
              </div>
            </div>
          `,
        });
      }

      // send admin email
      if (process.env.ADMIN_EMAIL) {
        const itemsHtml = data.metadata.items.map(
          item => `<tr>
                     <td style="padding:8px;border:1px solid #ddd;">${item.name}</td>
                     <td style="padding:8px;border:1px solid #ddd;text-align:center;">${item.quantity}</td>
                     <td style="padding:8px;border:1px solid #ddd;text-align:right;">GHS ${item.price}</td>
                   </tr>`
        ).join("");

        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: "New Duk's Juices Order Received 🛒",
          html: `
            <div style="font-family: Arial, sans-serif; max-width:600px; margin:auto; border:1px solid #eee; border-radius:8px; overflow:hidden;">
              <div style="background-color:#1976D2; color:white; padding:20px; text-align:center;">
                <h1>New Order Received</h1>
              </div>
              <div style="padding:20px;">
                <p>Order <strong>${reference}</strong> has been placed by ${fullName || "a customer"}.</p>
                <h3>Order Details:</h3>
                <table style="width:100%; border-collapse:collapse; margin-top:10px;">
                  <thead>
                    <tr style="background-color:#f7f7f7;">
                      <th style="padding:8px;border:1px solid #ddd;text-align:left;">Item</th>
                      <th style="padding:8px;border:1px solid #ddd;text-align:center;">Quantity</th>
                      <th style="padding:8px;border:1px solid #ddd;text-align:right;">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${itemsHtml}
                  </tbody>
                </table>
                <p style="margin-top:15px; font-weight:bold; text-align:right;">Total: GHS ${totalAmount}</p>
              </div>
            </div>
          `,
        });
      }

      await Cart.findOneAndUpdate({ userId }, { items: [] });
      console.log(`✅ Order created on backend verify: ${reference}`);
    }

    return res.redirect(`${process.env.FRONTEND_URL}/orders`);
  } catch (error) {
    console.error("Payment verification error:", error.response?.data || error.message);
    res.status(500).json({ message: "Payment verification failed" });
  }
};
