import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import fs from "fs";

import authRoutes from "./routes/auth.js";
import drinkRoutes from "./routes/drink.js";
import cartRoutes from "./routes/cart.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import orderRoutes from "./routes/orders.js";
import testEmailRoutes from "./routes/testEmail.js";

dotenv.config();

const app = express();

// Fix dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads folder exists
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// ---------------- Dynamic CORS ----------------
const allowedOrigins = [
  "http://localhost:8080",        // local frontend
  "https://www.duksjuice.com"     // production frontend
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `CORS policy: ${origin} not allowed`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
}));

// ⚠️ CRITICAL: Webhook MUST be configured BEFORE express.json()
app.use(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    // Save raw body for signature verification
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body.toString('utf8');
      // Parse for access to req.body.event, req.body.data
      try {
        req.body = JSON.parse(req.rawBody);
      } catch (e) {
        console.error('Webhook body parse error:', e);
        return res.status(400).send('Invalid JSON');
      }
    }
    next();
  }
);


// ---------------- Middleware ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static folder for images
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Request logger
app.use((req, res, next) => {
  console.log(`🟢 ${req.method} ${req.originalUrl}`);
  next();
});

// ---------------- Routes ----------------
app.use("/api/auth", authRoutes);
app.use("/api/drinks", drinkRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/test-email", testEmailRoutes);

// Test route
app.get("/", (req, res) => {
  res.send("Drink Shop Backend Running 🚀");
});

// ---------------- Unknown route handler ----------------
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ---------------- Global error handler ----------------
app.use((err, req, res, next) => {
  console.error("💥 Server Error:", err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// ---------------- MongoDB Connection ----------------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected successfully"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

// ---------------- Start server ----------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/api/payments/webhook`);
});

export default app;