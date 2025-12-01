import Cart from "../models/cart.js";
import Drink from "../models/drinks.js";

export const addToCart = async (req, res) => {
  try {
    const { drinkId, quantity } = req.body;
    const userId = req.user._id;

    const drink = await Drink.findById(drinkId);
    if (!drink) return res.status(404).json({ message: "Drink not found" });

    let cart = await Cart.findOne({ userId });

    if (!cart) {
      // Create cart if it doesn't exist
      cart = await Cart.create({
        userId,
        items: [{ drinkId, quantity: quantity || 1 }],
      });
    } else {
      const existingItem = cart.items.find(
        (item) => item.drinkId.toString() === drinkId
      );
      if (existingItem) {
        existingItem.quantity += quantity || 1;
      } else {
        cart.items.push({ drinkId, quantity: quantity || 1 });
      }
      await cart.save();
    }

    res.status(201).json({ message: "Cart updated", cart });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const getCartItems = async (req, res) => {
  try {
    const userId = req.user._id;
    const cart = await Cart.findOne({ userId }).populate("items.drinkId");

    if (!cart) return res.json({ cartItems: [] });

    const result = cart.items.map((item) => ({
      id: item._id,
      drinkId: item.drinkId._id,
      name: item.drinkId.name,
      price: item.drinkId.packs?.[0]?.price || 0,
      qty: item.quantity,
      packs: item.drinkId.packs,
      pack: item.drinkId.packs?.[0]?.pack || null,
      image: item.drinkId.imageUrl || "",
    }));

    res.json({ cartItems: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const removeFromCart = async (req, res) => {
  try {
    const { itemId } = req.params;
    const userId = req.user._id;

    const cart = await Cart.findOne({ userId });
    if (!cart) return res.status(404).json({ message: "Cart not found" });

    cart.items = cart.items.filter((item) => item._id.toString() !== itemId);
    await cart.save();

    res.json({ message: "Item removed from cart", cart });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
