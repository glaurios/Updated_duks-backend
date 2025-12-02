import axios from "axios";
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import User from "../models/user.js";
import { sendEmail } from "../utils/Email.js";

// ===============================================
// 1️⃣ Initialize Payment (Frontend -> Paystack)
// ===============================================
export const initializePayment = async (req, res) => {
  try {
    const { email: checkoutEmail, phone, provider, fullName, address, city = "", country = "Ghana" } = req.body;
    const userEmail = checkoutEmail || req.user.email;

    // Get cart with drink populated
    const cartItems = await Cart.find({ userId: req.user._id }).populate({
      path: "drinkId",
      strictPopulate: false,
    });

    if (!cartItems?.length) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    let total = 0;
    const items = cartItems
      .filter(item => item.drinkId)
      .map(item => {

        // 🧠 Use price from cart (correct pack)
        let price = item.price;

        // 🔁 If missing, fallback find pack inside drink model
        if (!price) {
          const selectedPack = item.drinkId.packs?.find(
            (pack) => pack.packSize === item.pack
          );
          price = selectedPack?.price || item.drinkId.packs?.[0]?.price || 0;
        }

        total += Number(price) * Number(item.quantity);

        return {
          drinkId: item.drinkId._id,
          name: item.drinkId.name,
          price, // ✔️ correct selected pack price
          quantity: item.quantity,
          pack: item.pack,
          image: item.drinkId.imageUrl || item.drinkId.image || "",
        };
      });

    const amount = total * 100;

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

    console.log("💰 Sending to Paystack Total:", total, "GHS");
    console.log("🧾 Items:", items);

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
    console.error("Payment init error:", error.response?.data || error.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
};

// ===============================================
// 2️⃣ Webhook: Paystack -> Backend (Auto Order)
// ===============================================
export const webhookPayment = async (req, res) => {
  try {
    const { event, data } = req.body;
    if (event !== "charge.success") return res.status(200).send("Ignored");

    const { reference, metadata, amount } = data;
    const userId = metadata?.userId;
    const items = metadata?.items || [];

    if (!userId || !items.length) return res.status(400).send("Invalid order metadata");

    const customer = metadata.customer || {
      fullName: metadata?.fullName || "Customer",
      email: metadata?.email,
      phone: metadata?.phone,
      address: metadata?.address || "Not provided",
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

      if (customer.email) {
        await sendEmail({
          to: customer.email,
          subject: "Your Order is Confirmed",
          html: `<p>Thanks ${customer.fullName}! Order total ₵${totalAmount}</p>`,
        });
      }

      if (process.env.ADMIN_EMAIL) {
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: "🛒 New Order",
          html: `<p>Order ${order._id} placed. Total ₵${totalAmount}</p>`,
        });
      }
    }

    await Cart.deleteMany({ userId });

    res.status(200).send("OK");

  } catch (error) {
    console.error("Webhook error:", error.message);
    res.status(500).send("Server error");
  }
};

// ===============================================
// 3️⃣ Verify Payment (Optional fallback)
// ===============================================
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
    const items = metadata.items || [];
    const userId = metadata.userId;
    const customer = metadata.customer || {};

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
    }

    return res.redirect(`${process.env.FRONTEND_URL}/orders`);

  } catch (error) {
    console.error("Verify error:", error.message);
    res.status(500).json({ message: "Payment verification failed" });
  }
};
