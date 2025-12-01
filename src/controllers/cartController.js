import Cart from "../models/cart.js";
import Drink from "../models/drinks.js";

// Add item to cart (handles duplicates safely)
export const addToCart = async (req, res) => {
  try {
    let { drinkId, quantity = 1, pack } = req.body;
    const userId = req.user._id;

    quantity = Number(quantity);
    pack = Number(pack);

    const drink = await Drink.findById(drinkId);
    if (!drink) return res.status(404).json({ message: "Drink not found" });

    if (!Array.isArray(drink.packs) || drink.packs.length === 0) {
      return res.status(400).json({ message: "Drink has no packs available" });
    }

    // Use findOneAndUpdate with upsert to avoid duplicate key errors
    const cartItem = await Cart.findOneAndUpdate(
      { userId, drinkId, pack },
      { $inc: { quantity } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ message: "Added to cart", cartItem });
  } catch (err) {
    console.error("❌ Add to cart error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Get all cart items for a user
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
    console.error("❌ Get cart items error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Remove item from cart
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
    console.error("❌ Remove from cart error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Update quantity of a cart item
export const updateCartItemQuantity = async (req, res) => {
  try {
    const { id } = req.params; // cart item _id
    let { quantity } = req.body;
    const userId = req.user._id;

    quantity = Number(quantity);
    if (!quantity || quantity < 1) {
      return res.status(400).json({ message: "Quantity must be at least 1" });
    }

    const cartItem = await Cart.findOneAndUpdate(
      { _id: id, userId },
      { $set: { quantity } },
      { new: true }
    );

    if (!cartItem) return res.status(404).json({ message: "Cart item not found" });

    res.json({ message: "Quantity updated", cartItem });
  } catch (err) {
    console.error("❌ Update cart item quantity error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Update pack of a cart item
export const updateCartItemPack = async (req, res) => {
  try {
    const { id } = req.params;
    const { pack } = req.body;
    const userId = req.user._id;

    const cartItem = await Cart.findOneAndUpdate(
      { _id: id, userId },
      { $set: { pack: Number(pack) } },
      { new: true }
    );

    if (!cartItem) return res.status(404).json({ message: "Cart item not found" });

    res.json({ message: "Pack updated", cartItem });
  } catch (err) {
    console.error("❌ Update cart item pack error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
