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
    console.log("Webhook body:", req.body);

    const { event, data } = req.body;

    // Only handle successful charges
    if (event !== "charge.success") {
      return res.status(200).send("Event ignored");
    }

    const { reference, metadata, amount } = data;
    const totalAmount = amount / 100;

    // Ensure userId exists
    const userId = metadata.userId;
    if (!userId) {
      console.error("Webhook error: missing userId in metadata");
      return res.status(400).send("Missing userId in metadata");
    }

    // Fetch user info
    const user = await User.findById(userId);
    const fullNameFinal = metadata.fullName || user?.fullName || "Customer";
    const phoneFinal = metadata.phone || user?.phone || "N/A";
    const addressFinal = metadata.address || user?.address || "N/A";
    const emailFinal = metadata.email || user?.email || "no-email@example.com";

    // Check if order already exists
    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items: metadata.items || [],
        totalAmount,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
        customer: {
          fullName: fullNameFinal,
          phone: phoneFinal,
          email: emailFinal,
          address: addressFinal,
        },
      });
      console.log(`✅ Order created: ${reference}`);

      // Send customer email
      if (emailFinal) {
        const itemsHtml = (metadata.items || []).map(
          item => `<tr>
                     <td style="padding:8px;border:1px solid #ddd;">${item.name}</td>
                     <td style="padding:8px;border:1px solid #ddd;text-align:center;">${item.quantity}</td>
                     <td style="padding:8px;border:1px solid #ddd;text-align:right;">GHS ${item.price}</td>
                   </tr>`
        ).join("");

        await sendEmail({
          to: emailFinal,
          subject: "Your Duk's Juices Order is Confirmed ✅",
          html: `
            <div style="font-family: Arial, sans-serif; max-width:600px; margin:auto; border:1px solid #eee; border-radius:8px; overflow:hidden;">
              <div style="background-color:#FF6F00; color:white; padding:20px; text-align:center;">
                <h1>Duk's Juices</h1>
                <p>Order Confirmation</p>
              </div>
              <div style="padding:20px;">
                <h2>Hi ${fullNameFinal},</h2>
                <p>Your order <strong>${reference}</strong> has been confirmed. Thank you for shopping with us!</p>
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
                <p>Cheers,<br>Duk's Juices Team 🍹</p>
              </div>
            </div>
          `,
        });
      }

      // Send admin email
      if (process.env.ADMIN_EMAIL) {
        const itemsHtml = (metadata.items || []).map(
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
                <p>Order <strong>${reference}</strong> placed by ${fullNameFinal}.</p>
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

      // Clear cart
      await Cart.deleteMany({ userId });
      console.log(`🧹 Cart cleared for user ${userId}`);
    } else {
      console.log(`⚠️ Order already exists for reference ${reference}`);
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

    const { userId } = data.metadata;

    // Fetch user info as fallback if missing
    const user = await User.findById(userId);
    const fullNameFinal = data.metadata.fullName || user?.fullName || "Customer";
    const phoneFinal = data.metadata.phone || user?.phone || "N/A";
    const addressFinal = data.metadata.address || user?.address || "N/A";
    const emailFinal = data.metadata.email || user?.email || "no-email@example.com";
    const totalAmount = data.amount / 100;

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
          fullName: fullNameFinal,
          phone: phoneFinal,
          email: emailFinal,
          address: addressFinal,
        },
      });
      console.log(`✅ Order created on backend verify: ${reference}`);

      // Emails can be sent here same as webhook if needed...
      // (You can reuse the webhook email code or create a helper function)
    }

    return res.redirect(`${process.env.FRONTEND_URL}/orders`);
  } catch (error) {
    console.error("Payment verification error:", error.response?.data || error.message);
    res.status(500).json({ message: "Payment verification failed" });
  }
};
