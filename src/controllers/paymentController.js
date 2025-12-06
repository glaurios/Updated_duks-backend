// src/controllers/paymentController.js
import crypto from "crypto";
import axios from "axios";
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import User from "../models/user.js";
import { sendEmail } from "../utils/Email.js";

/* ==================== HELPERS ==================== */

// Structured logging
const logEvent = (event, data) => {
  console.log(`[PAYMENT ${event}]`, {
    ...data,
    timestamp: new Date().toISOString(),
  });
};

// Verify Paystack webhook signature
const verifyPaystackSignature = (req) => {
  // req.body will be a Buffer because you used express.raw() on this route
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
  const header = (req.headers["x-paystack-signature"] || req.headers["X-Paystack-Signature"] || "").toString();
  return hash === header;
};
// Validate customer data
const validateCustomer = (customer) => {
  const errors = [];
  if (!customer?.email?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    errors.push("Valid email is required");
  }
  if (!customer?.phone || customer.phone.length < 10) {
    errors.push("Valid phone number is required");
  }
  if (!customer?.fullName || customer.fullName.length < 2) {
    errors.push("Full name is required");
  }
  if (!customer?.address || customer.address.length < 5) {
    errors.push("Valid address is required");
  }
  return errors;
};

// Normalize and calculate order items
const normalizeItems = (items) => {
  let total = 0;
  let totalQty = 0;

  const normalized = items
    .filter(item => item && item.drinkId)
    .map(item => {
      const price = Number(item.price || 0);
      const quantity = Math.max(1, Number(item.quantity || 1));
      const subtotal = price * quantity;
      
      total += subtotal;
      totalQty += quantity;

      return {
        drinkId: item.drinkId,
        name: item.name || "Item",
        pack: item.pack || "",
        price,
        quantity,
        subtotal,
        image: item.image || "",
      };
    });

  return { items: normalized, total, totalQty };
};

// Send customer confirmation email
const sendCustomerEmail = async (order, customer, items, totalAmount) => {
  if (!customer?.email) return;

  try {
    const itemsHTML = items
      .map(
        (it) =>
          `<li>${it.quantity} × ${it.name} ${it.pack ? `(${it.pack})` : ""} — ₵${it.price.toFixed(2)}</li>`
      )
      .join("");

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #0f5132; color: #fff; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">Order Confirmed ✅</h2>
        </div>
        <div style="padding: 20px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
          <p>Hi ${customer.fullName},</p>
          <p>Thank you for your order! Your payment has been confirmed.</p>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>Order ID:</strong> ${order._id}</p>
            <p style="margin: 5px 0;"><strong>Reference:</strong> ${order.paystackReference}</p>
            ${order.deliveryDate ? `<p style="margin: 5px 0;"><strong>Delivery:</strong> ${order.deliveryDate} ${order.deliveryTime || ""}</p>` : ""}
          </div>

          <h3>Order Summary:</h3>
          <ul style="padding-left: 20px;">${itemsHTML}</ul>
          
          <div style="text-align: right; margin-top: 20px; padding-top: 15px; border-top: 2px solid #0f5132;">
            <p style="margin: 0; font-size: 20px; font-weight: bold;">Total: ₵${totalAmount.toFixed(2)}</p>
          </div>

          <p style="margin-top: 20px; color: #666; font-size: 14px;">
            We'll notify you when your order is ready for delivery.
          </p>
        </div>
      </div>
    `;

    await sendEmail({
      to: customer.email,
      subject: `Order Confirmed - ${order._id}`,
      html,
    });

    logEvent("CUSTOMER_EMAIL_SENT", { 
      orderId: order._id, 
      email: customer.email 
    });
  } catch (error) {
    console.error("Failed to send customer email:", error);
    logEvent("CUSTOMER_EMAIL_FAILED", { 
      orderId: order._id, 
      error: error.message 
    });
  }
};

// Send admin notification email
const sendAdminEmail = async (order, customer, items, totalAmount) => {
  if (!process.env.ADMIN_EMAIL) return;

  try {
    const itemsRows = items
      .map(
        (it) => `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;">
            <img src="${it.image || 'https://via.placeholder.com/60'}" width="60" style="border-radius: 4px;" alt="${it.name}">
          </td>
          <td style="padding: 8px; border: 1px solid #ddd;">
            <strong>${it.name}</strong>
            ${it.pack ? `<br><small style="color: #666;">Pack: ${it.pack}</small>` : ""}
          </td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${it.quantity}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">₵${it.price.toFixed(2)}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">₵${it.subtotal.toFixed(2)}</td>
        </tr>
      `
      )
      .join("");

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
        <div style="background: #0f5132; color: #fff; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">🛒 New Order Received</h2>
          <p style="margin: 10px 0 0;">Order ID: <strong>${order._id}</strong></p>
        </div>
        
        <div style="padding: 20px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 8px 8px;">
          <h3 style="margin-top: 0;">Customer Information</h3>
          <table style="width: 100%; margin-bottom: 20px;">
            <tr>
              <td style="padding: 5px 0;"><strong>Name:</strong></td>
              <td>${customer.fullName}</td>
            </tr>
            <tr>
              <td style="padding: 5px 0;"><strong>Email:</strong></td>
              <td>${customer.email}</td>
            </tr>
            <tr>
              <td style="padding: 5px 0;"><strong>Phone:</strong></td>
              <td>${customer.phone}</td>
            </tr>
            <tr>
              <td style="padding: 5px 0;"><strong>Address:</strong></td>
              <td>${customer.address}${customer.city ? `, ${customer.city}` : ""}</td>
            </tr>
          </table>

          <h3>Order Items</h3>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
            <thead>
              <tr style="background: #f5f5f5;">
                <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Image</th>
                <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Product</th>
                <th style="padding: 8px; border: 1px solid #ddd; text-align: center;">Qty</th>
                <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">Unit Price</th>
                <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRows}
            </tbody>
          </table>

          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px;">
            <p style="margin: 5px 0;"><strong>Total Items:</strong> ${order.totalItems}</p>
            ${order.deliveryDate ? `<p style="margin: 5px 0;"><strong>Delivery:</strong> ${order.deliveryDate} ${order.deliveryTime || ""}</p>` : ""}
            <p style="margin: 5px 0;"><strong>Payment Reference:</strong> ${order.paystackReference}</p>
            <p style="margin: 15px 0 5px; font-size: 20px; font-weight: bold; color: #0f5132;">
              Total: ₵${totalAmount.toFixed(2)}
            </p>
          </div>

          <p style="margin-top: 20px; font-size: 12px; color: #666;">
            Log into your admin dashboard to manage this order.
          </p>
        </div>
      </div>
    `;

    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `🛒 New Order — ₵${totalAmount.toFixed(2)}`,
      html,
    });

    logEvent("ADMIN_EMAIL_SENT", { 
      orderId: order._id 
    });
  } catch (error) {
    console.error("Failed to send admin email:", error);
    logEvent("ADMIN_EMAIL_FAILED", { 
      orderId: order._id, 
      error: error.message 
    });
  }
};

/* ==================== 1. INITIALIZE PAYMENT ==================== */
export const initializePayment = async (req, res) => {
  try {
    const {
      email: checkoutEmail,
      phone,
      fullName,
      address,
      city = "",
      country = "Ghana",
      deliveryDate = null,
      deliveryTime = null,
      vendor = "",
    } = req.body;

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ 
        success: false, 
        message: "Authentication required" 
      });
    }

    // Build customer object
    const customer = {
      fullName: fullName || req.user?.fullName || "",
      email: checkoutEmail || req.user?.email || "",
      phone: phone || req.user?.phone || "",
      address: address || req.user?.address || "",
      city: city || req.user?.city || "",
      country: country || req.user?.country || "Ghana",
    };

    // Validate customer information
    const validationErrors = validateCustomer(customer);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer information",
        errors: validationErrors,
      });
    }

    // Get cart items from database
    const cartItems = await Cart.find({ userId }).populate({
      path: "drinkId",
      strictPopulate: false,
    });

    if (!cartItems?.length) {
      return res.status(400).json({ 
        success: false, 
        message: "Cart is empty" 
      });
    }

    // Build items array with server-side prices (NEVER trust frontend)
    const items = [];
    let total = 0;

    for (const item of cartItems) {
      if (!item.drinkId) continue;

      // Get price from database
      let price = item.price;
      if (!price) {
        const packs = item.drinkId.packs || item.drinkId.pack || [];
        const selectedPack = packs.find(
          (p) => String(p.pack || p.packSize) === String(item.pack)
        );
        price = selectedPack?.price || packs[0]?.price || 0;
      }

      const quantity = Math.max(1, Number(item.quantity || 1));
      const subtotal = price * quantity;
      total += subtotal;

      items.push({
        drinkId: item.drinkId._id,
        name: item.drinkId.name,
        price,
        quantity,
        pack: item.pack,
        image: item.drinkId.imageUrl || item.drinkId.image || "",
      });
    }

    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid items in cart",
      });
    }

    // Paystack expects amount in pesewas (kobo)
    const amount = Math.round(total * 100);

    // Prepare metadata (use consistent structure)
    const metadata = {
      userId: userId.toString(),
      customer,
      items,
      deliveryDate,
      deliveryTime,
      vendor,
      calculatedTotal: total, // For verification in webhook
    };

    logEvent("INIT_PAYMENT", {
      userId,
      email: customer.email,
      amount: total,
      itemCount: items.length,
    });

    // Initialize payment with Paystack
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: customer.email,
        amount,
        currency: "GHS",
        callback_url: `${process.env.FRONTEND_URL}/orders`,
        metadata,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json({
      success: true,
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (error) {
    console.error("Payment initialization error:", error);
    logEvent("INIT_ERROR", {
      error: error.message,
      response: error.response?.data,
    });

    return res.status(500).json({
      success: false,
      message: "Payment initialization failed. Please try again.",
      ...(process.env.NODE_ENV === "development" && {
        error: error.response?.data || error.message,
      }),
    });
  }
};

/* ==================== 2. PAYSTACK WEBHOOK ==================== */
export const webhookPayment = async (req, res) => {
 try {
    // Parse raw body into JSON (safe because express.raw used for this route)
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString("utf8"));
    } else if (typeof req.body === "string") {
      payload = JSON.parse(req.body);
    } else {
      payload = req.body;
    }

    // verify signature using raw bytes
    if (!verifyPaystackSignature(req)) {
      logEvent("WEBHOOK_INVALID_SIGNATURE", { ip: req.ip, headers: req.headers });
      return res.status(401).send("Invalid signature");
    }

    const { event, data } = req.body;

    // Only process successful charges
    if (event !== "charge.success") {
      logEvent("WEBHOOK_IGNORED", { event });
      return res.status(200).send("Event ignored");
    }

    const { reference, metadata = {}, amount: paystackAmount } = data;

    // Extract metadata with consistent structure
    const { userId, customer, items, deliveryDate, deliveryTime, vendor, calculatedTotal } = metadata;

    // Validate required data
    if (!items || items.length === 0) {
      logEvent("WEBHOOK_INVALID_ITEMS", { reference });
      return res.status(400).send("Invalid order items");
    }

    if (!customer || !customer.email) {
      logEvent("WEBHOOK_INVALID_CUSTOMER", { reference });
      return res.status(400).send("Invalid customer data");
    }

    // Normalize items and calculate totals
    const { items: normalizedItems, total: totalAmount, totalQty } = normalizeItems(items);

    if (normalizedItems.length === 0) {
      logEvent("WEBHOOK_NO_VALID_ITEMS", { reference });
      return res.status(400).send("No valid items");
    }

    // CRITICAL: Verify payment amount matches calculated total
    const expectedAmount = Math.round(totalAmount * 100); // Convert to pesewas
    const amountDifference = Math.abs(paystackAmount - expectedAmount);

    if (amountDifference > 100) { // Allow 1 GHS tolerance
      logEvent("WEBHOOK_AMOUNT_MISMATCH", {
        reference,
        paystackAmount,
        expectedAmount,
        difference: amountDifference,
      });

      // Alert admin about mismatch
      if (process.env.ADMIN_EMAIL) {
        try {
          await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: `🚨 Payment Amount Mismatch - ${reference}`,
            html: `
              <h2>⚠️ Payment Amount Mismatch Detected</h2>
              <p><strong>Reference:</strong> ${reference}</p>
              <p><strong>Paystack Amount:</strong> ₵${(paystackAmount / 100).toFixed(2)}</p>
              <p><strong>Expected Amount:</strong> ₵${totalAmount.toFixed(2)}</p>
              <p><strong>Difference:</strong> ₵${(amountDifference / 100).toFixed(2)}</p>
              <p><strong>Customer:</strong> ${customer.email}</p>
              <p style="color: red;"><strong>Action Required:</strong> Manual review needed</p>
            `,
          });
        } catch (err) {
          console.error("Failed to send mismatch alert:", err);
        }
      }
    }

    // Use atomic operation to prevent duplicate orders
    const order = await Order.findOneAndUpdate(
      { paystackReference: reference },
      {
        $setOnInsert: {
          userId: userId || null,
          customer,
          items: normalizedItems,
          totalAmount,
          totalItems: totalQty,
          deliveryDate: deliveryDate || null,
          deliveryTime: deliveryTime || null,
          vendor: vendor || "",
          paystackReference: reference,
          paymentStatus: "paid",
          orderStatus: "confirmed",
          createdAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    // Check if this is a new order (not duplicate webhook)
    const isNewOrder = order.createdAt > new Date(Date.now() - 10000); // Last 10 seconds

    if (!isNewOrder) {
      logEvent("WEBHOOK_DUPLICATE", {
        orderId: order._id,
        reference,
      });
      return res.status(200).send("Order already processed");
    }

    logEvent("WEBHOOK_ORDER_CREATED", {
      orderId: order._id,
      reference,
      totalAmount,
      email: customer.email,
    });

    // Send emails (async, don't block response)
    Promise.all([
      sendCustomerEmail(order, customer, normalizedItems, totalAmount),
      sendAdminEmail(order, customer, normalizedItems, totalAmount),
    ]).catch(err => console.error("Email error:", err));

    // Clear cart
    if (userId) {
      try {
        await Cart.deleteMany({ userId });
        logEvent("CART_CLEARED", { userId });
      } catch (err) {
        console.warn("Failed to clear cart:", err);
      }
    }

    return res.status(200).send("Webhook processed successfully");
  } catch (error) {
    console.error("Webhook error:", error);
    logEvent("WEBHOOK_ERROR", {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).send("Webhook processing failed");
  }
};

/* ==================== 3. VERIFY PAYMENT (FALLBACK) ==================== */
export const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;

    // Check if order already exists
    const existingOrder = await Order.findOne({ paystackReference: reference });
    if (existingOrder) {
      logEvent("VERIFY_ORDER_EXISTS", { 
        orderId: existingOrder._id, 
        reference 
      });
      return res.redirect(`${process.env.FRONTEND_URL}/orders`);
    }

    // Verify with Paystack
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const data = response.data.data;

    if (data.status !== "success") {
      logEvent("VERIFY_PAYMENT_FAILED", { reference, status: data.status });
      return res.status(400).json({
        success: false,
        message: "Payment was not successful",
      });
    }

    // Process similar to webhook (extract and create order)
    const { metadata = {}, amount: paystackAmount } = data;
    const { userId, customer, items, deliveryDate, deliveryTime, vendor } = metadata;

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid order data",
      });
    }

    const { items: normalizedItems, total: totalAmount, totalQty } = normalizeItems(items);

    const order = await Order.create({
      userId: userId || null,
      customer,
      items: normalizedItems,
      totalAmount,
      totalItems: totalQty,
      deliveryDate: deliveryDate || null,
      deliveryTime: deliveryTime || null,
      vendor: vendor || "",
      paystackReference: reference,
      paymentStatus: "paid",
      orderStatus: "confirmed",
    });

    logEvent("VERIFY_ORDER_CREATED", {
      orderId: order._id,
      reference,
      totalAmount,
    });

    // Send emails
    Promise.all([
      sendCustomerEmail(order, customer, normalizedItems, totalAmount),
      sendAdminEmail(order, customer, normalizedItems, totalAmount),
    ]).catch(err => console.error("Email error:", err));

    // Clear cart
    if (userId) {
      try {
        await Cart.deleteMany({ userId });
      } catch (err) {
        console.warn("Failed to clear cart:", err);
      }
    }

    return res.redirect(`${process.env.FRONTEND_URL}/orders`);
  } catch (error) {
    console.error("Verify payment error:", error);
    logEvent("VERIFY_ERROR", {
      reference: req.params.reference,
      error: error.message,
    });

    return res.status(500).json({
      success: false,
      message: "Payment verification failed",
      ...(process.env.NODE_ENV === "development" && {
        error: error.response?.data || error.message,
      }),
    });
  }
};
