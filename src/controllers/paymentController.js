import axios from "axios";
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import User from "../models/user.js";
import { sendEmail } from "../utils/Email.js";

// ===============================================
// 1️⃣ Initialize Payment (Frontend -> Paystack)
// (KEEP as-is: server computes amount from cart; your frontend calls this)
// ===============================================
export const initializePayment = async (req, res) => {
  try {
    const { email: checkoutEmail, phone, provider, fullName, address, city = "", country = "Ghana", deliveryDate = null, deliveryTime = null } = req.body;
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
        // Use price from cart (correct pack) if available
        let price = item.price;

        // If missing, fallback to pack price on drink model or first pack
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

    const amount = Math.round(total * 100);

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
        // include delivery info so webhook/verify can save it
        deliveryDate: deliveryDate ? deliveryDate : null,
        deliveryTime: deliveryTime ? deliveryTime : null,
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
    console.log("💥 Paystack webhook received");
    const { event, data } = req.body;
    if (event !== "charge.success") {
      console.log(`Webhook: ignored event ${event}`);
      return res.status(200).send("Ignored");
    }

    const { reference, metadata, amount } = data;
    const userId = metadata?.userId;
    const items = Array.isArray(metadata?.items) ? metadata.items : [];
    const deliveryDate = metadata?.deliveryDate || metadata?.delivery?.date || null;
    const deliveryTime = metadata?.deliveryTime || metadata?.delivery?.time || null;

    if (!userId || !items.length) {
      console.error("Webhook: missing userId or items");
      return res.status(400).send("Invalid order metadata");
    }

    // Build customer object: support both new metadata.customer and old flattened fields
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
      fullName: customerFromMetadata.fullName || customerFromFlat.fullName || "Customer",
      email: customerFromMetadata.email || customerFromFlat.email || "",
      phone: customerFromMetadata.phone || customerFromFlat.phone || "",
      address: customerFromMetadata.address || customerFromFlat.address || "Not provided",
      city: customerFromMetadata.city || customerFromFlat.city || "",
      country: customerFromMetadata.country || customerFromFlat.country || "Ghana",
    };

    // Compute totals and total item count from metadata.items (trusting metadata but computing for safety)
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

    const totalAmount = Number(amount || computedTotal * 100) / 100; // amount is in smallest unit from Paystack

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
      });

      console.log(`✅ Order created: ${order._id}`);

      // Customer email (confirmation)
      if (customer.email) {
        try {
          const customerItemsHTML = normalizedItems.map(it => `<li>${it.quantity} × ${it.name} ${it.pack ? `(${it.pack})` : ''} — ₵${it.price} (subtotal ₵${it.subtotal.toFixed(2)})</li>`).join("");
          const customerHTML = `
            <div style="font-family: Arial, sans-serif; max-width:600px;">
              <h2 style="color:#0f5132;">Order Confirmed ✅</h2>
              <p>Hi ${customer.fullName},</p>
              <p>Thanks for shopping with us. Your order <strong>${order._id}</strong> has been confirmed.</p>
              <h3>Order summary</h3>
              <ul>${customerItemsHTML}</ul>
              <p><strong>Total:</strong> ₵${totalAmount.toFixed(2)}</p>
              ${deliveryDate || deliveryTime ? `<p><strong>Delivery:</strong> ${deliveryDate ? deliveryDate : ''} ${deliveryTime ? ' at ' + deliveryTime : ''}</p>` : ''}
              <p>We will notify you when your order is out for delivery.</p>
            </div>
          `;
          await sendEmail({
            to: customer.email,
            subject: "Your Order is Confirmed ✅",
            html: customerHTML,
          });
          console.log(`📧 Confirmation email sent to ${customer.email}`);
        } catch (emailErr) {
          console.warn("⚠️ Failed to send customer email:", emailErr.message || emailErr);
        }
      }

      // Admin email: professional HTML template with images, counts, totals and a View Order button
      if (process.env.ADMIN_EMAIL) {
        try {
          const itemsRowsHTML = normalizedItems.map(it => `
            <tr>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:left;">
                <img src="${it.image || 'https://via.placeholder.com/80x80?text=No+Image'}" alt="${it.name}" width="80" style="display:block;border-radius:6px;">
              </td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:left;">
                <strong>${it.name}</strong>
                ${it.pack ? `<div style="font-size:12px;color:#666;">Pack: ${it.pack}</div>` : ''}
              </td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:center;">${it.quantity}</td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:right;">₵${it.price.toFixed(2)}</td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:right;">₵${it.subtotal.toFixed(2)}</td>
            </tr>
          `).join("");

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
                  ${customer.email ? `${customer.email}<br/>` : ''}
                  ${customer.phone ? `${customer.phone}<br/>` : ''}
                  ${customer.address ? `${customer.address}<br/>` : ''}
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
                    <p style="margin:4px 0 0;"><strong>Delivery:</strong> ${deliveryDate ? deliveryDate : 'Not set'} ${deliveryTime ? ' at ' + deliveryTime : ''}</p>
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

          await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: `🛒 New Order — ₵${totalAmount.toFixed(2)}`,
            html: adminHTML,
          });

          console.log(`📧 Admin notified at ${process.env.ADMIN_EMAIL}`);
        } catch (adminEmailErr) {
          console.warn("⚠️ Failed to send admin email:", adminEmailErr.message || adminEmailErr);
        }
      }
    } else {
      console.log(`⚠️ Order already exists for reference ${reference}`);
    }

    // Clear user's cart (best-effort)
    try {
      await Cart.deleteMany({ userId });
      console.log(`🧹 Cart cleared for user ${userId}`);
    } catch (cartErr) {
      console.warn("⚠️ Failed to clear cart:", cartErr.message || cartErr);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook error:", error.message || error);
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
    if (data.status !== "success") {
      console.error("Verify: payment not successful for", reference);
      return res.status(400).json({ message: "Payment failed" });
    }

    const metadata = data.metadata || {};
    const items = Array.isArray(metadata.items) ? metadata.items : [];
    const userId = metadata.userId;
    const deliveryDate = metadata.deliveryDate || metadata.delivery?.date || null;
    const deliveryTime = metadata.deliveryTime || metadata.delivery?.time || null;
    const customerFromMetadata = metadata.customer || {};
    const customerFromFlat = {
      fullName: metadata?.fullName,
      email: metadata?.email,
      phone: metadata?.phone,
      address: metadata?.address,
    };
    const customer = {
      fullName: customerFromMetadata.fullName || customerFromFlat.fullName || "Customer",
      email: customerFromMetadata.email || customerFromFlat.email || "",
      phone: customerFromMetadata.phone || customerFromFlat.phone || "",
      address: customerFromMetadata.address || customerFromFlat.address || "Not provided",
    };

    // Compute totals and normalise items
    let computedTotal = 0;
    let totalItemsCount = 0;
    const normalizedItems = items.map(it => {
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

      console.log(`✅ Order created (verify): ${order._id}`);

      // Clear cart
      try {
        await Cart.deleteMany({ userId });
      } catch (cartErr) {
        console.warn("⚠️ Failed to clear cart (verify):", cartErr.message || cartErr);
      }

      // Send admin email (same template as webhook)
      if (process.env.ADMIN_EMAIL) {
        try {
          const itemsRowsHTML = normalizedItems.map(it => `
            <tr>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:left;">
                <img src="${it.image || 'https://via.placeholder.com/80x80?text=No+Image'}" alt="${it.name}" width="80" style="display:block;border-radius:6px;">
              </td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:left;">
                <strong>${it.name}</strong>
                ${it.pack ? `<div style="font-size:12px;color:#666;">Pack: ${it.pack}</div>` : ''}
              </td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:center;">${it.quantity}</td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:right;">₵${it.price.toFixed(2)}</td>
              <td style="padding:8px;border:1px solid #e9e9e9;text-align:right;">₵${it.subtotal.toFixed(2)}</td>
            </tr>
          `).join("");

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
                  ${customer.email ? `${customer.email}<br/>` : ''}
                  ${customer.phone ? `${customer.phone}<br/>` : ''}
                  ${customer.address ? `${customer.address}<br/>` : ''}
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
                    <p style="margin:4px 0 0;"><strong>Delivery:</strong> ${deliveryDate ? deliveryDate : 'Not set'} ${deliveryTime ? ' at ' + deliveryTime : ''}</p>
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

          await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: `🛒 New Order — ₵${totalAmount.toFixed(2)}`,
            html: adminHTML,
          });

          console.log(`📧 Admin notified (verify) at ${process.env.ADMIN_EMAIL}`);
        } catch (adminEmailErr) {
          console.warn("⚠️ Failed to send admin email (verify):", adminEmailErr.message || adminEmailErr);
        }
      }
    } else {
      console.log(`⚠️ Order already exists for reference ${reference} (verify)`);
    }

    return res.redirect(`${process.env.FRONTEND_URL}/orders`);
  } catch (error) {
    console.error("Verify error:", error.response?.data || error.message || error);
    res.status(500).json({ message: "Payment verification failed" });
  }
};
