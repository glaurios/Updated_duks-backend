// src/utils/Email.js
import sgMail from "@sendgrid/mail";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_USER || "no-reply@example.com";

if (!SENDGRID_API_KEY) {
  console.error("❌ SENDGRID_API_KEY not set. Emails will fail until configured.");
} else {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

/**
 * sendEmail({ to, subject, html, text })
 * - returns SendGrid response (array) on success
 * - throws error on failure
 */
export const sendEmail = async ({ to, subject, html, text }) => {
  if (!SENDGRID_API_KEY) {
    throw new Error("SendGrid API key not configured (SENDGRID_API_KEY).");
  }
  if (!to) {
    throw new Error("Missing 'to' address for sendEmail.");
  }

  const msg = {
    to,
    from: EMAIL_FROM,
    subject,
    html,
    text: text || undefined,
  };

  try {
    const res = await sgMail.send(msg);
    // res is an array of responses for each recipient (usually length 1)
    const status = Array.isArray(res) && res[0] && res[0].statusCode ? res[0].statusCode : "unknown";
    console.log(`📧 SendGrid: email sent to ${to} (status ${status})`);
    return res;
  } catch (err) {
    // SendGrid returns detailed error info under err.response.body
    if (err && err.response && err.response.body) {
      console.error("❌ SendGrid error response:", JSON.stringify(err.response.body, null, 2));
    } else {
      console.error("❌ SendGrid error:", err && err.message ? err.message : err);
    }
    throw err;
  }
};
