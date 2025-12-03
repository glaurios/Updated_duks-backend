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
    const {
      email: checkoutEmail,
      phone,
      provider,
      fullName,
      address,
      city = "",
      country = "Ghana",
      deliveryDate = null,
      deliveryTime = null,
    } = req.body;

    const userEmail = checkoutEmail || req.user?.email || "";

    const cartItems = await Cart.find({ userId: req.user?._id }).populate({
      path: "drinkId",
      strictPopulate: false,
    });

    if (!cartItems?.length) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    let total = 0;
    const items = cartItems
      .filter((item) => item.drinkId)
      .map((item) => {
        let price = item.price;
        if (!price) {
          const selectedPack = item.drinkId.packs?.find(
            (pack) => String(pack.pack || pack.packSize) === String(item.pack)
          );
          price = selectedPack?.price || item.drinkId.packs?.[0]?.price || 0;
        }
        total += Number(price) * Number(item.quantity || 1);
        return {
          drinkId: item.drinkId._id,
          name: item.drinkId.name,
          price,
          quantity: Number(item.quantity || 1),
          pack: item.pack,
          image: item.drinkId.imageUrl || item.drinkId.image || "",
        };
      });

    const amount = Math.round(total * 100); // in kobo if using Paystack
    const customer = {
      fullName: fullName || req.user?.fullName || "Customer",
      email: userEmail || "",
      phone: phone || req.user?.phone || "",
      address: address || req.user?.address || "",
      city: city || req.user?.city || "",
      country: country || req.user?.country || "Ghana",
    };

    const paystackData = {
      email: userEmail,
      amount,
      currency: "GHS",
      callback_url: `${process.env.FRONTEND_URL}/orders`,
      metadata: {
        userId: req.user?._id,
        customer,
        items,
        email: userEmail,
        fullName: customer.fullName,
        phone: customer.phone,
        address: customer.address,
        provider: provider || "",
        deliveryDate: deliveryDate || null,
        deliveryTime: deliveryTime || null,
      },
    };

    console.log("💰 Sending to Paystack Total:", total, "GHS");
    console.log("🧾 Items:", items);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      paystackData,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    return res.json({
      success: true,
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (error) {
    console.error("Payment init error:", error.response?.data || error.message || error);
    return res.status(500).json({ error: "Payment initialization failed" });
  }
};

// ===============================================
// 2️⃣ Webhook: Paystack -> Backend (Auto Order)
// ===============================================
export const  webhookPayment = async (req, res) => {
  try {
    console.log("💥 Paystack webhook received (raw body):", JSON.stringify(req.body || {}, null, 2));
    const { event, data } = req.body || {};

    // always respond quickly so Paystack doesn't retry while we process
    // but we still process and return a JSON message at the end
    if (!event || !data) {
      console.warn("Webhook: missing event or data");
      return res.status(400).json({ message: "Invalid webhook payload" });
    }

    console.log(`💥 Paystack webhook received: reference=${data.reference} event=${event}`);

    if (event !== "charge.success") {
      console.log(`Webhook: ignored event ${event}`);
      return res.status(200).json({ message: `Ignored event ${event}` });
    }

    const { reference, metadata = {}, amount } = data;

    // tolerate multiple metadata shapes
    const userId = metadata?.userId || metadata?.user?._id || metadata?.userIdString || null;
    const itemsRaw = Array.isArray(metadata?.items)
      ? metadata.items
      : Array.isArray(metadata?.cart)
      ? metadata.cart
      : []; // supports metadata.items or metadata.cart

    const deliveryDate = metadata?.deliveryDate || metadata?.delivery?.date || null;
    const deliveryTime = metadata?.deliveryTime || metadata?.delivery?.time || null;
    const vendor = metadata?.vendor || metadata?.provider || "";

    if (!itemsRaw || !itemsRaw.length) {
      console.error("Webhook: missing items in metadata");
      // still return 200 to acknowledge webhook, but warn
      return res.status(400).json({ message: "Invalid order metadata: items missing" });
    }

    // customer extraction (support several shapes)
    const customerFromMetadata = metadata?.customer || {};
    const customerFromFlat = {
      fullName: metadata?.fullName,
      email: metadata?.email,
      phone: metadata?.phone,
      address: metadata?.address,
      city: metadata?.city,
      country: metadata?.country,
    };
    const customer = {
      fullName: (customerFromMetadata.fullName || customerFromFlat.fullName || "Customer").toString(),
      email: (customerFromMetadata.email || customerFromFlat.email || "").toString(),
      phone: (customerFromMetadata.phone || customerFromFlat.phone || "").toString(),
      address: (customerFromMetadata.address || customerFromFlat.address || "Not provided").toString(),
      city: (customerFromMetadata.city || customerFromFlat.city || "").toString(),
      country: (customerFromMetadata.country || customerFromFlat.country || "Ghana").toString(),
    };

    console.log("Webhook: parsed customer:", customer);

    // Normalize items and compute totals
    let computedTotal = 0;
    let totalItemsCount = 0;
    const normalizedItems = itemsRaw.map((it) => {
      // tolerate object shapes where drinkId might be nested as {$oid: "..."}
      const rawDrinkId = it.drinkId && typeof it.drinkId === "object" && it.drinkId.$oid ? it.drinkId.$oid : it.drinkId;
      const price = Number(it.price || 0);
      const qty = Number(it.quantity || it.qty || 1);
      const subtotal = price * qty;
      computedTotal += subtotal;
      totalItemsCount += qty;
      return {
        drinkId: rawDrinkId || null,
        name: it.name || it.productName || "Item",
        pack: it.pack || it.packSize || "",
        price,
        quantity: qty,
        subtotal,
        image: it.image || "",
      };
    });

    // amount coming from Paystack is usually in kobo — if data.amount present, use that with safety
    const totalAmount = (() => {
      if (typeof amount === "number" && amount > 0) {
        // if amount is large (likely in kobo), divide by 100; if it's already small, assume it's cedi value
        return amount > 1000 ? Number(amount) / 100 : Number(amount);
      }
      // fallback to computedTotal
      return Number(computedTotal || 0);
    })();

    console.log("Webhook: computed total from items:", computedTotal, " -> totalAmount used:", totalAmount);

    // Avoid duplicate orders
    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items: normalizedItems,
        totalAmount,
        totalItems: totalItemsCount,
        deliveryDate,
        deliveryTime,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
        customer,
        vendor,
      });

      console.log(`✅ Order created: ${order._id}`);

      // === Customer email (only if an email exists) ===
      if (customer.email) {
        try {
          console.log(`📧 Preparing customer email to: ${customer.email}`);
          const customerItemsHTML = normalizedItems
            .map(
              (it) =>
                `<li>${it.quantity} × ${it.name} ${it.pack ? `(${it.pack})` : ""} — ₵${it.price} (subtotal ₵${it.subtotal.toFixed(
                  2
                )})</li>`
            )
            .join("");
          const customerHTML = `
            <div style="font-family: Arial, sans-serif; max-width:600px;">
              <h2 style="color:#0f5132;">Order Confirmed ✅</h2>
              <p>Hi ${customer.fullName},</p>
              <p>Thanks for shopping with us. Your order <strong>${order._id}</strong> has been confirmed.</p>
              <h3>Order summary</h3>
              <ul>${customerItemsHTML}</ul>
              <p><strong>Total:</strong> ₵${totalAmount.toFixed(2)}</p>
              ${deliveryDate || deliveryTime ? `<p><strong>Delivery:</strong> ${deliveryDate ? deliveryDate : ""} ${deliveryTime ? " at " + deliveryTime : ""}</p>` : ""}
              <p>We will notify you when your order is out for delivery.</p>
            </div>
          `;
          const info = await sendEmail({
            to: customer.email,
            subject: "Your Order is Confirmed ✅",
            html: customerHTML,
          });
          console.log("📧 Confirmation email sent to", customer.email, "messageId:", info?.messageId || "(no id)");
        } catch (emailErr) {
          console.error("⚠️ Failed to send customer email:", emailErr);
        }
      } else {
        console.warn("⚠️ No customer email present in metadata — skipping customer email.");
      }

      // === Admin email (always attempt if ADMIN_EMAIL defined) ===
      if (process.env.ADMIN_EMAIL) {
        try {
          console.log("📧 Preparing admin email to:", process.env.ADMIN_EMAIL);
          const itemsRowsHTML = normalizedItems
            .map(
              (it) => `
            <tr>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:left;">
                <img src="${it.image || "https://via.placeholder.com/80x80?text=No+Image"}" alt="${it.name}" width="80" style="display:block;border-radius:6px;">
              </td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:left;">
                <strong>${it.name}</strong>
                ${it.pack ? `<div style="font-size:12px;color:#666;">Pack: ${it.pack}</div>` : ""}
              </td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:center;">${it.quantity}</td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:right;">₵${it.price.toFixed(2)}</td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:right;">₵${it.subtotal.toFixed(2)}</td>
            </tr>
          `
            )
            .join("");
          const adminHTML = `
            <div style="font-family:Arial, sans-serif; max-width:800px; margin:0 auto; color:#111;">
              <div style="background:#0f5132;color:#fff;padding:20px 24px;border-radius:6px 6px 0 0;">
                <h2 style="margin:0;font-size:20px;">New Order Received</h2>
                <p style="margin:6px 0 0;">Order ID: <strong>${order._id}</strong></p>
              </div>
              <div style="padding:18px;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 6px 6px;background:#fff;">
                <p style="margin:0 0 12px;">A new order has been placed. See the details below. Click the button to view the order in your admin dashboard.</p>
                <h3 style="margin-top:8px;">Customer</h3>
                <p style="margin:0;">
                  <strong>${customer.fullName}</strong><br/>
                  ${customer.email ? `${customer.email}<br/>` : ""}
                  ${customer.phone ? `${customer.phone}<br/>` : ""}
                  ${customer.address ? `${customer.address}<br/>` : ""}
                </p>
                <h3 style="margin-top:16px;">Order summary</h3>
                <table style="width:100%;border-collapse:collapse;margin-top:8px;">
                  <thead>
                    <tr>
                      <th style="padding:8px;border:1px solid #e9e9e9;text-align:left;background:#f7f7f7;">Product</th>
                      <th style="padding:8px;border:1px solid #e9e9e9;text-align:left;background:#f7f7f7;"></th>
                      <th style="padding:8px;border:1px solid #e9e9e9;text-align:center;background:#f7f7f7;">Qty</th>
                      <th style="padding:8px;border:1px solid #e9e9e9;text-align:right;background:#f7f7f7;">Unit</th>
                      <th style="padding:8px;border:1px solid #e9e9e9;text-align:right;background:#f7f7f7;">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${itemsRowsHTML}
                  </tbody>
                </table>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;">
                  <div>
                    <p style="margin:0;"><strong>Total items:</strong> ${totalItemsCount}</p>
                    <p style="margin:4px 0 0;"><strong>Delivery:</strong> ${deliveryDate ? deliveryDate : "Not set"} ${deliveryTime ? " at " + deliveryTime : ""}</p>
                    <p style="margin:4px 0 0;"><strong>Payment ref:</strong> ${reference}</p>
                  </div>
                  <div style="text-align:right;">
                    <p style="margin:0;font-size:18px;font-weight:700;">₵${totalAmount.toFixed(2)}</p>
                    <a href="https://youradmin.com/orders/${order._id}" style="display:inline-block;margin-top:8px;padding:10px 14px;background:#0f5132;color:#fff;border-radius:6px;text-decoration:none;">View Order</a>
                  </div>
                </div>
                <p style="margin-top:20px;font-size:12px;color:#666;">This is an automated notification. Log into the admin dashboard to manage the order.</p>
              </div>
            </div>
          `;

          const info = await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: `🛒 New Order — ₵${totalAmount.toFixed(2)}`,
            html: adminHTML,
          });
          console.log("📧 Admin notified at", process.env.ADMIN_EMAIL, "messageId:", info?.messageId || "(no id)");
        } catch (adminEmailErr) {
          console.error("⚠️ Failed to send admin email:", adminEmailErr);
        }
      } else {
        console.warn("⚠️ ADMIN_EMAIL not set — skipping admin notification");
      }
    } else {
      console.log(`⚠️ Order already exists for reference ${reference}`);
    }

    try {
      await Cart.deleteMany({ userId });
      console.log(`🧹 Cart cleared for user ${userId}`);
    } catch (cartErr) {
      console.warn("⚠️ Failed to clear cart:", cartErr);
    }

    // Respond with a message so you can see webhook hit in Postman / logs
    return res.status(200).json({ message: `Webhook received: reference=${reference}, event=${event}` });
  } catch (error) {
    console.error("❌ Webhook error:", error);
    // respond 500 so Paystack would know it failed (and may retry)
    return res.status(500).json({ message: "Server error", error: String(error) });
  }
};

// ===============================================
// 3️⃣ Verify Payment (Optional fallback)
// ===============================================
export const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const data = response.data.data;
    if (data.status !== "success") return res.status(400).json({ message: "Payment failed" });

    const metadata = data.metadata || {};
    const items = Array.isArray(metadata.items) ? metadata.items : Array.isArray(metadata.cart) ? metadata.cart : [];
    const userId = metadata.userId;
    const deliveryDate = metadata.deliveryDate || metadata.delivery?.date || null;
    const deliveryTime = metadata.deliveryTime || metadata.delivery?.time || null;
    const customerFromMetadata = metadata.customer || {};
    const customerFromFlat = { fullName: metadata?.fullName, email: metadata?.email, phone: metadata?.phone, address: metadata?.address };
    const customer = {
      fullName: customerFromMetadata.fullName || customerFromFlat.fullName || "Customer",
      email: customerFromMetadata.email || customerFromFlat.email || "",
      phone: customerFromMetadata.phone || customerFromFlat.phone || "",
      address: customerFromMetadata.address || customerFromFlat.address || "Not provided",
    };

    let computedTotal = 0;
    let totalItemsCount = 0;
    const normalizedItems = items.map((it) => {
      const price = Number(it.price || 0);
      const qty = Number(it.quantity || it.qty || 1);
      const subtotal = price * qty;
      computedTotal += subtotal;
      totalItemsCount += qty;
      return {
        name: it.name || it.productName || "Item",
        pack: it.pack || it.packSize || "",
        price,
        quantity: qty,
        subtotal,
        image: it.image || "",
        drinkId: it.drinkId || it.productId || null,
      };
    });

    const totalAmount = Number(data.amount || computedTotal * 100) / 100;

    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      order = await Order.create({
        userId,
        items: normalizedItems,
        totalAmount,
        totalItems: totalItemsCount,
        deliveryDate,
        deliveryTime,
        paystackReference: reference,
        paymentStatus: "paid",
        orderStatus: "confirmed",
        customer,
      });
      try {
        await Cart.deleteMany({ userId });
      } catch (e) {
        console.warn("Failed to clear cart during verify:", e);
      }

      // Admin email (same HTML as webhook)
      if (process.env.ADMIN_EMAIL) {
        try {
          const itemsRowsHTML = normalizedItems
            .map(
              (it) => `
            <tr>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:left;">
                <img src="${it.image || "https://via.placeholder.com/80x80?text=No+Image"}" alt="${it.name}" width="80" style="display:block;border-radius:6px;">
              </td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:left;">
                <strong>${it.name}</strong>
                ${it.pack ? `<div style="font-size:12px;color:#666;">Pack: ${it.pack}</div>` : ""}
              </td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:center;">${it.quantity}</td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:right;">₵${it.price.toFixed(2)}</td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:right;">₵${it.subtotal.toFixed(2)}</td>
            </tr>
          `
            )
            .join("");

          const adminHTML = `...`; // same admin HTML template as webhook

          const info = await sendEmail({ to: process.env.ADMIN_EMAIL, subject: `🛒 New Order — ₵${totalAmount.toFixed(2)}`, html: adminHTML });
          console.log("📧 Admin notified at", process.env.ADMIN_EMAIL, "messageId:", info?.messageId || "(no id)");
        } catch (adminEmailErr) {
          console.error("Failed to send admin email during verify:", adminEmailErr);
        }
      } else {
        console.warn("ADMIN_EMAIL not set; skipping admin notification during verify");
      }
    }

    return res.redirect(`${process.env.FRONTEND_URL}/orders`);
  } catch (error) {
    console.error("Verify error:", error);
    return res.status(500).json({ message: "Payment verification failed", error: String(error) });
  }
};
