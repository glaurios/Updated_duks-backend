// src/utils/Email.js
import nodemailer from "nodemailer";

function createTransportOptions() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 587); // 587 works on Render
  // use secure only for port 465, otherwise false (STARTTLS on 587)
  const secure = process.env.SMTP_SECURE === "true" || port === 465;

  return {
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Timeouts to fail fast instead of hanging forever
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000), // 10s
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 10000),
    tls: {
      // allow self-signed certs; Render and some providers require this
      rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "true" ? false : true,
    },
  };
}

let transporter = nodemailer.createTransport(createTransportOptions());

// Optional: verify transporter at startup (logs only)
transporter.verify()
  .then(() => console.log("📧 SMTP transporter verified"))
  .catch((err) => {
    console.warn("⚠️ SMTP transporter verification failed:", err && err.message ? err.message : err);
    // don't throw here — we'll attempt to send and optionally fall back
  });

/**
 * Try sending email with optional retries and fallback SMTP (if provided).
 * - Retries the primary transporter up to `retries` times on transient errors.
 * - If configured, will try fallback SMTP credentials env (SMTP_FALLBACK_*)
 */
async function trySendMail(mailOptions, { retries = 1, fallback = true } = {}) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    try {
      attempt++;
      const info = await transporter.sendMail(mailOptions);
      console.log(`📧 Email sent (attempt ${attempt}):`, info.messageId);
      return info;
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Email send attempt ${attempt} failed:`, err && err.message ? err.message : err);

      // If it's a timeout (ETIMEDOUT / ECONNRESET / EAI_AGAIN) and we still have retries, continue
      const transientCodes = ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"];
      const isTransient = transientCodes.includes(err && err.code);

      if (!isTransient) break;

      if (attempt <= retries) {
        // small backoff
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }

  // If primary failed and we have fallback SMTP configured, try it
  const fallbackHost = process.env.SMTP_FALLBACK_HOST;
  if (fallback && fallbackHost) {
    console.log("🔁 Attempting fallback SMTP transport...");
    const fallbackOptions = {
      host: process.env.SMTP_FALLBACK_HOST,
      port: Number(process.env.SMTP_FALLBACK_PORT || 587),
      secure: process.env.SMTP_FALLBACK_SECURE === "true" || Number(process.env.SMTP_FALLBACK_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_FALLBACK_USER,
        pass: process.env.SMTP_FALLBACK_PASS,
      },
      connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
      greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
      socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 10000),
      tls: { rejectUnauthorized: false },
    };

    const fallbackTransporter = nodemailer.createTransport(fallbackOptions);

    try {
      const info = await fallbackTransporter.sendMail(mailOptions);
      console.log("📧 Email sent via fallback SMTP:", info.messageId);
      return info;
    } catch (fbErr) {
      console.error("❌ Fallback SMTP also failed:", fbErr && fbErr.message ? fbErr.message : fbErr);
      // keep lastError as primary error for throwing
      lastError = fbErr;
    }
  }

  // All attempts failed — throw the most recent error for caller to handle
  throw lastError || new Error("Unknown email send failure");
}

export const sendEmail = async ({ to, subject, html, text }) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    const message = "SMTP_USER or SMTP_PASS not configured in environment";
    console.error("❌ Email config missing:", message);
    throw new Error(message);
  }

  const mailOptions = {
    from: `"Drink Shop" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text: text || undefined,
  };

  try {
    // Try primary with 1 retry (2 attempts total). Adjust retries if you want.
    return await trySendMail(mailOptions, { retries: 1, fallback: true });
  } catch (err) {
    console.error("❌ Email failed:", err && err.message ? err.message : err);
    // Re-throw so calling code (webhook) can react and log / retry if desired.
    throw err;
  }
};
