// src/utils/Email.js
import nodemailer from "nodemailer";

// Load Gmail SMTP creds
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === "true"; // false for Gmail TLS

// Default "from" email
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER || "no-reply@example.com";

// Validate environment
if (!SMTP_USER || !SMTP_PASS) {
  console.error("❌ Gmail SMTP not configured. Emails will fail until SMTP_USER & SMTP_PASS are set.");
}

// Create transporter
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: SMTP_SECURE, // Gmail uses TLS on port 587 → false
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

/**
 * sendEmail({ to, subject, html, text })
 * Works with Gmail SMTP
 */
export const sendEmail = async ({ to, subject, html, text }) => {
  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error("Gmail SMTP not configured (missing SMTP_USER / SMTP_PASS).");
  }
  if (!to) {
    throw new Error("Missing 'to' address for sendEmail.");
  }

  const mailOptions = {
    from: EMAIL_FROM,
    to,
    subject,
    html,
    text: text || undefined,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`📧 Gmail SMTP: email sent to ${to} (messageId: ${info.messageId})`);
    return info;
  } catch (err) {
    console.error("❌ Gmail SMTP error:", err.message || err);
    throw err;
  }
};
