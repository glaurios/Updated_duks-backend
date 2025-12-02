import Cart from "../models/cart.js";
import Drink from "../models/drinks.js";

// ---------------- Add item to cart ----------------
export const addToCart = async (req, res) => {
  try {
    let { drinkId, quantity = 1, pack } = req.body;
    const userId = req.user._id;

    quantity = Number(quantity);

    const drink = await Drink.findById(drinkId);
    if (!drink) return res.status(404).json({ message: "Drink not found" });

    // Default to first available pack if not provided
    if (!pack) {
      pack = drink.packs?.[0]?.pack;
    }
    pack = Number(pack);

    if (!drinkId || isNaN(pack) || quantity < 1) {
      return res.status(400).json({ message: "Invalid drink, pack, or quantity" });
    }

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

// ---------------- Get all cart items ----------------
export const getCartItems = async (req, res) => {
  try {
    const userId = req.user._id;
    const cartItems = await Cart.find({ userId }).populate("drinkId");

    const result = cartItems.map((item) => ({
      id: item._id,
      drinkId: item.drinkId._id,
      name: item.drinkId.name,
      price: item.drinkId.packs?.find(p => p.pack === item.pack)?.price || 0,
      qty: item.quantity,
      packs: item.drinkId.packs,
      pack: item.pack,
      image: item.drinkId.imageUrl || "",
    }));

    res.json({ cartItems: result });
  } catch (err) {
    console.error("❌ Get cart items error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ---------------- Remove item from cart ----------------
export const removeFromCart = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const deletedItem = await Cart.findOneAndDelete({ _id: id, userId });
    if (!deletedItem) return res.status(404).json({ message: "Cart item not found" });

    res.json({ message: "Item removed from cart", deletedItem });
  } catch (err) {
    console.error("❌ Remove from cart error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ---------------- Update cart item quantity ----------------
export const updateCartItemQuantity = async (req, res) => {
  try {
    const { id } = req.params;
    let { quantity } = req.body;
    const userId = req.user._id;

    quantity = Number(quantity);
    if (isNaN(quantity) || quantity < 1) {
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

// ---------------- Update cart item pack ----------------
export const updateCartItemPack = async (req, res) => {
  try {
    const { id } = req.params;
    let { pack } = req.body;
    const userId = req.user._id;

    pack = Number(pack);
    if (isNaN(pack)) return res.status(400).json({ message: "Invalid pack value" });

    const cartItem = await Cart.findById(id);
    if (!cartItem) return res.status(404).json({ message: "Cart item not found" });

    // Merge with existing cart item if same drinkId and pack exists
    const existingItem = await Cart.findOne({ userId, drinkId: cartItem.drinkId, pack });
    if (existingItem) {
      existingItem.quantity += cartItem.quantity;
      await existingItem.save();
      await cartItem.deleteOne();
      return res.json({ message: "Pack updated (merged with existing item)", cartItem: existingItem });
    }

    cartItem.pack = pack;
    await cartItem.save();

    res.json({ message: "Pack updated", cartItem });
  } catch (err) {
    console.error("❌ Update cart item pack error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};



// ---------------- Add multiple items to cart (Batch) ----------------
export const addManyToCart = async (req, res) => {
  try {
    const userId = req.user._id;
    const items = req.body.items; // array of { drinkId, quantity, pack }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Items array required" });
    }

    const results = [];

    for (const item of items) {
      let { drinkId, quantity = 1, pack } = item;

      quantity = Number(quantity);

      const drink = await Drink.findById(drinkId);
      if (!drink) continue;

      if (!pack) {
        pack = drink.packs?.[0]?.pack;
      }
      pack = Number(pack);

      if (!drinkId || isNaN(pack) || quantity < 1) continue;

      const cartItem = await Cart.findOneAndUpdate(
        { userId, drinkId, pack },
        { $inc: { quantity } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      results.push(cartItem);
    }

    res.status(201).json({
      message: "Batch items added",
      cartItems: results,
    });
  } catch (err) {
    console.error("❌ AddMany error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

