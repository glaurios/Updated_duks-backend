import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
  addToCart,
  getCartItems,
  removeFromCart,
  updateCartItemQuantity,
  updateCartItemPack,
  addManyToCart,
} from "../controllers/cartController.js";

const router = express.Router();

router.post("/", authMiddleware, addToCart);
router.post("/batch", authMiddleware, addManyToCart); // NEW
router.get("/", authMiddleware, getCartItems);
router.delete("/:id", authMiddleware, removeFromCart);
router.patch("/:id/quantity", authMiddleware, updateCartItemQuantity);
router.patch("/:id/pack", authMiddleware, updateCartItemPack);

export default router;
