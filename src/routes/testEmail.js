import express from "express";
import { sendEmail } from "../utils/Email.js"; // adjust the path to your email.js

const router = express.Router();

// Test email route
router.post("/send-test-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
      return res.status(400).json({ message: "to, subject, and message are required" });
    }

    await sendEmail({
      to,
      subject,
      html: `<p>${message}</p>`,
    });

    res.status(200).json({ message: "Test email sent successfully" });
  } catch (err) {
    console.error("Test email error:", err);
    res.status(500).json({ message: "Failed to send test email" });
  }
});

export default router;
