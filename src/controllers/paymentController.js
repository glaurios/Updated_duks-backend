import axios from "axios";
import Order from "../models/order.js";
import Cart from "../models/cart.js";
import User from "../models/user.js";
import { sendEmail } from "../utils/Email.js";

// 1️⃣ Initialize Payment
export const initializePayment = async (req, res) => {
  try {
    const { 
      email: checkoutEmail, 
      phone, 
      provider, 
      fullName, 
      address, 
      city = "",
      country = "Ghana" 
    } = req.body;
    
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

    // Build proper customer object with ALL required fields
    const customer = {
      fullName: fullName || req.user.fullName || "Customer",
      email: userEmail,
      phone: phone || req.user.phone || "",
      address: address || req.user.address || "",
      city: city || req.user.city || "",
      country: country || req.user.country || "Ghana"
    };

    const paystackData = {
      email: userEmail,
      amount,
      currency: "GHS",
      callback_url: `${process.env.FRONTEND_URL}/orders`,
      metadata: {
        userId: req.user._id,
        customer: customer,  // Pass FULL customer object
        items,
        // Keep other metadata separate for backward compatibility
        email: userEmail,
        fullName: customer.fullName,
        phone: customer.phone,
        address: customer.address,
        provider: provider || "",
      },
    };

    console.log("💰 Payment initialized with metadata:", JSON.stringify(paystackData.metadata, null, 2));

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

// 2️⃣ Webhook receives payment success - FIXED VERSION
export const webhookPayment = async (req, res) => {
  try {
    console.log("💥 Paystack Webhook received:", new Date().toISOString());
    console.log("📦 Webhook body:", JSON.stringify(req.body, null, 2));
    
    const { event, data } = req.body;

    if (event !== "charge.success") {
      console.log(`Ignoring event: ${event}`);
      return res.status(200).send("Event ignored");
    }

    const { reference, metadata, amount, customer: paystackCustomer } = data;
    
    console.log("🔍 Metadata received:", JSON.stringify(metadata, null, 2));
    console.log("👤 Paystack customer data:", JSON.stringify(paystackCustomer, null, 2));

    // Extract from metadata - handle both old and new format
    const items = metadata?.items || [];
    const userId = metadata?.userId;
    
    // Get customer data from multiple possible sources
    const customerFromMetadata = metadata?.customer || {};
    const customerFromOldFormat = {
      fullName: metadata?.fullName,
      email: metadata?.email,
      phone: metadata?.phone,
      address: metadata?.address,
      city: metadata?.city,
      country: metadata?.country
    };

    // Build final customer object with fallbacks
    const customer = {
      fullName: customerFromMetadata.fullName || 
                customerFromOldFormat.fullName || 
                paystackCustomer?.first_name + " " + paystackCustomer?.last_name ||
                "Customer",
      email: customerFromMetadata.email || 
             customerFromOldFormat.email || 
             paystackCustomer?.email || 
             "",
      phone: customerFromMetadata.phone || 
             customerFromOldFormat.phone || 
             paystackCustomer?.phone || 
             "",
      address: customerFromMetadata.address || 
               customerFromOldFormat.address || 
               paystackCustomer?.metadata?.address || 
               "Not provided",
      city: customerFromMetadata.city || 
            customerFromOldFormat.city || 
            paystackCustomer?.metadata?.city || 
            "",
      country: customerFromMetadata.country || 
               customerFromOldFormat.country || 
               paystackCustomer?.metadata?.country || 
               "Ghana"
    };

    console.log("👑 Final customer object:", JSON.stringify(customer, null, 2));

    if (!userId) {
      console.error("❌ Missing userId in metadata");
      return res.status(400).send("Missing userId");
    }

    if (!items || items.length === 0) {
      console.error("❌ No items in metadata");
      return res.status(400).send("No items in order");
    }

    const totalAmount = amount / 100;

    // Check if order already exists
    let order = await Order.findOne({ paystackReference: reference });
    if (!order) {
      try {
        order = await Order.create({
          userId,
          items,
          totalAmount,
          paystackReference: reference,
          paymentStatus: "paid",
          orderStatus: "confirmed",
          customer: customer, // Use the properly built customer object
        });
        
        console.log(`✅ Order created: ${order._id}`);

        // Send email to customer
        if (customer.email) {
          try {
            await sendEmail({
              to: customer.email,
              subject: "Your Order is Confirmed ✅",
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2 style="color: #4CAF50;">Order Confirmed!</h2>
                  <p>Hi ${customer.fullName},</p>
                  <p>Thanks for shopping with <strong>Duk's Juices</strong>. Your order <strong>${order._id}</strong> is confirmed and being prepared.</p>
                  
                  <h3>Order Summary:</h3>
                  <ul>
                    ${items.map(item => `
                      <li>${item.quantity} × ${item.name} ${item.pack ? `(${item.pack})` : ''} — ₵${item.price}</li>
                    `).join('')}
                  </ul>
                  
                  <p><strong>Total Amount:</strong> ₵${totalAmount.toFixed(2)}</p>
                  <p><strong>Payment Status:</strong> Paid</p>
                  <p><strong>Order Status:</strong> Confirmed</p>
                  
                  ${customer.address ? `<p><strong>Delivery Address:</strong> ${customer.address}</p>` : ''}
                  
                  <p>We'll notify you when your order is out for delivery. Thank you!</p>
                </div>
              `,
            });
            console.log(`📧 Email sent to customer: ${customer.email}`);
          } catch (emailError) {
            console.warn("⚠️ Failed to send email to customer:", emailError.message);
          }
        }

        // Send email to admin
        if (process.env.ADMIN_EMAIL) {
          try {
            await sendEmail({
              to: process.env.ADMIN_EMAIL,
              subject: "🛒 New Order Received",
              html: `
                <div>
                  <h3>New Order Notification</h3>
                  <p><strong>Order ID:</strong> ${order._id}</p>
                  <p><strong>Customer:</strong> ${customer.fullName}</p>
                  <p><strong>Email:</strong> ${customer.email}</p>
                  <p><strong>Phone:</strong> ${customer.phone}</p>
                  <p><strong>Total Amount:</strong> ₵${totalAmount.toFixed(2)}</p>
                  <p><strong>Items:</strong> ${items.length} item(s)</p>
                </div>
              `,
            });
            console.log(`📧 Admin notified: ${process.env.ADMIN_EMAIL}`);
          } catch (adminEmailError) {
            console.warn("⚠️ Failed to send email to admin:", adminEmailError.message);
          }
        }

      } catch (createError) {
        console.error("❌ Order creation failed:", createError);
        // If it's a validation error, log the specific fields
        if (createError.name === 'ValidationError') {
          console.error("Validation errors:", createError.errors);
        }
        throw createError;
      }
    } else {
      console.log(`⚠️ Order already exists for reference ${reference}`);
    }

    // Clear user's cart
    try {
      await Cart.deleteMany({ userId });
      console.log(`🧹 Cart cleared for user ${userId}`);
    } catch (cartError) {
      console.warn("⚠️ Failed to clear cart:", cartError.message);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    console.error("Stack trace:", error.stack);
    res.status(500).send("Server error");
  }
};

// 3️⃣ Verify Payment - FIXED VERSION
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

    // Extract metadata
    const metadata = data.metadata || {};
    const userId = metadata.userId;
    const items = metadata.items || [];
    
    // Get customer data (same logic as webhook)
    const customerFromMetadata = metadata.customer || {};
    const customerFromOldFormat = {
      fullName: metadata.fullName,
      email: metadata.email,
      phone: metadata.phone,
      address: metadata.address,
      city: metadata.city,
      country: metadata.country
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
        customer: customer,
      });

      console.log(`✅ Order created on backend verify: ${order._id}`);

      // Clear cart
      await Cart.deleteMany({ userId });
      
      // Send email notifications (similar to webhook)
      if (customer.email) {
        try {
          await sendEmail({
            to: customer.email,
            subject: "Your Order is Confirmed ✅",
            html: `<p>Hi ${customer.fullName}, your order ${order._id} has been confirmed. Total: ₵${totalAmount}</p>`,
          });
        } catch (emailError) {
          console.warn("Email failed:", emailError.message);
        }
      }
    }

    return res.redirect(`${process.env.FRONTEND_URL}/orders`);
  } catch (error) {
    console.error("Payment verification error:", error.response?.data || error.message);
    res.status(500).json({ message: "Payment verification failed" });
  }
};