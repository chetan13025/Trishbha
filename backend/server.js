require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const Razorpay = require("razorpay");

const app = express();
const PORT = process.env.PORT || 5000;
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.use(helmet());
app.use(cors({ origin: (process.env.CLIENT_ORIGIN || "http://localhost:5500").split(",").map(s => s.trim()), credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, limit: 250, standardHeaders: "draft-7", legacyHeaders: false }));

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["customer", "admin"], default: "customer" }
}, { timestamps: true });
const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: "" },
  category: { type: String, default: "Other" },
  pricePaise: { type: Number, required: true, min: 0 },
  imageUrl: String,
  stock: { type: Number, default: 0, min: 0 },
  active: { type: Boolean, default: true }
}, { timestamps: true });
const quoteSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  customerType: { type: String, enum: ["Individual", "Business"], default: "Individual" },
  projectName: String, technology: String, material: String, finish: String,
  weightGrams: { type: Number, min: 1, max: 100000 },
  printHours: { type: Number, min: 1, max: 10000 },
  quantity: { type: Number, min: 1, max: 10000, default: 1 },
  notes: String, modelFile: String,
  estimatePaise: { type: Number, required: true },
  status: { type: String, enum: ["requested", "reviewing", "quoted", "accepted", "rejected"], default: "requested" }
}, { timestamps: true });
const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  items: [{ product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" }, name: String, quantity: Number, unitPricePaise: Number }],
  amountPaise: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  paymentStatus: { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
  orderStatus: { type: String, enum: ["placed", "confirmed", "printing", "shipped", "completed", "cancelled"], default: "placed" }
}, { timestamps: true });
const User = mongoose.model("User", userSchema);
const Product = mongoose.model("Product", productSchema);
const Quote = mongoose.model("Quote", quoteSchema);
const Order = mongoose.model("Order", orderSchema);

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "Invalid or expired token" }); }
}
function admin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowed = new Set([".stl", ".obj", ".3mf", ".step", ".stp"]);
  if (!allowed.has(ext)) return cb(new Error("Unsupported model format. Use STL, OBJ, 3MF or STEP."));
  cb(null, true);
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({ storage, fileFilter, limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024, files: 1 } });

app.get("/api/health", (req, res) => res.json({ status: "ok", service: "trishbha-api", time: new Date().toISOString() }));

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || typeof password !== "string" || password.length < 8)
    return res.status(400).json({ error: "Name, valid email and password (at least 8 characters) are required" });
  const normalizedEmail = String(email).trim().toLowerCase();
  if (await User.findOne({ email: normalizedEmail })) return res.status(409).json({ error: "Email is already registered" });
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ name, email: normalizedEmail, passwordHash });
  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
  res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
}));
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const user = await User.findOne({ email: String(req.body.email || "").trim().toLowerCase() });
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.passwordHash)))
    return res.status(401).json({ error: "Invalid email or password" });
  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
  res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
}));
app.get("/api/auth/me", auth, asyncRoute(async (req, res) => {
  const user = await User.findById(req.user.id).select("name email role");
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user });
}));

app.get("/api/products", asyncRoute(async (req, res) => {
  const filter = { active: true };
  if (req.query.category) filter.category = req.query.category;
  if (req.query.q) filter.name = { $regex: String(req.query.q).slice(0, 80), $options: "i" };
  res.json({ products: await Product.find(filter).sort({ createdAt: -1 }).limit(100) });
}));
app.post("/api/products", auth, admin, asyncRoute(async (req, res) => {
  const product = await Product.create(req.body);
  res.status(201).json({ product });
}));

app.post("/api/uploads/model", auth, upload.single("model"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Select a 3D model file" });
  res.status(201).json({ file: { id: req.file.filename, originalName: req.file.originalname, size: req.file.size, format: path.extname(req.file.originalname).slice(1).toLowerCase() } });
});

app.post("/api/quotes", auth, asyncRoute(async (req, res) => {
  const { customerType = "Individual", projectName, technology = "FDM", material = "PLA", finish = "Standard finish", weightGrams, printHours, quantity = 1, notes, modelFile } = req.body;
  const w = Number(weightGrams), h = Number(printHours), q = Number(quantity);
  if (![w,h,q].every(Number.isFinite) || w < 1 || h < 1 || q < 1 || w > 100000 || h > 10000 || q > 10000)
    return res.status(400).json({ error: "Provide valid weight, print hours and quantity" });
  const materialRate = { PLA: 2, PETG: 2.8, ABS: 3, TPU: 4, "Standard Resin": 5, "Tough Resin": 8, "Engineering Resin": 10, "Nylon PA12": 7, "Nylon Glass Filled": 9 }[material] || 3;
  const technologyFactor = { FDM: 1, SLA: 1.8, DLP: 2, SLS: 3, MJF: 4 }[technology] || 1;
  const estimatePaise = Math.round((w * materialRate + h * 35) * technologyFactor * q * 100);
  const quote = await Quote.create({ user: req.user.id, customerType, projectName, technology, material, finish, weightGrams: w, printHours: h, quantity: q, notes, modelFile, estimatePaise });
  res.status(201).json({ quote, estimate: { amount: estimatePaise / 100, currency: "INR", disclaimer: "Indicative estimate only. Final price requires model inspection and manufacturing review." } });
}));
app.get("/api/quotes/mine", auth, asyncRoute(async (req, res) => {
  res.json({ quotes: await Quote.find({ user: req.user.id }).sort({ createdAt: -1 }) });
}));

app.post("/api/orders/checkout", auth, asyncRoute(async (req, res) => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
    return res.status(503).json({ error: "Payments are not configured. Add Razorpay credentials to the server environment." });
  const lines = Array.isArray(req.body.items) ? req.body.items : [];
  if (!lines.length) return res.status(400).json({ error: "Cart is empty" });
  const ids = lines.map(x => String(x.productId));
  const products = await Product.find({ _id: { $in: ids }, active: true });
  const byId = new Map(products.map(p => [String(p._id), p]));
  const orderItems = lines.map(line => {
    const p = byId.get(String(line.productId)), qty = Number(line.quantity);
    if (!p || !Number.isInteger(qty) || qty < 1 || qty > 100) throw Object.assign(new Error("Invalid product or quantity"), { status: 400 });
    if (p.stock < qty) throw Object.assign(new Error("Insufficient stock for " + p.name), { status: 409 });
    return { product: p._id, name: p.name, quantity: qty, unitPricePaise: p.pricePaise };
  });
  const amountPaise = orderItems.reduce((sum, i) => sum + i.quantity * i.unitPricePaise, 0);
  const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  const rpOrder = await razorpay.orders.create({ amount: amountPaise, currency: "INR", receipt: "trish_" + Date.now() });
  const order = await Order.create({ user: req.user.id, items: orderItems, amountPaise, razorpayOrderId: rpOrder.id });
  res.status(201).json({ orderId: order._id, razorpayOrderId: rpOrder.id, amount: amountPaise, currency: "INR", keyId: process.env.RAZORPAY_KEY_ID });
}));
app.post("/api/payments/verify", auth, asyncRoute(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const order = await Order.findOne({ razorpayOrderId: razorpay_order_id, user: req.user.id });
  if (!order) return res.status(404).json({ error: "Order not found" });
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "").update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
  const receivedSignature = Buffer.from(String(razorpay_signature || ""));\n  const expectedSignature = Buffer.from(expected);\n  if (!process.env.RAZORPAY_KEY_SECRET || receivedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(expectedSignature, receivedSignature)) {
    order.paymentStatus = "failed"; await order.save(); return res.status(400).json({ error: "Payment signature verification failed" });
  }
  order.razorpayPaymentId = razorpay_payment_id; order.paymentStatus = "paid"; await order.save();
  res.json({ verified: true, orderId: order._id });
}));
app.get("/api/orders/mine", auth, asyncRoute(async (req, res) => {
  res.json({ orders: await Order.find({ user: req.user.id }).sort({ createdAt: -1 }) });
}));

app.use((err, req, res, next) => {
  console.error(err.message);
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
});
mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/trishbha")
  .then(() => app.listen(PORT, () => console.log("Trishbha API listening on port " + PORT)))
  .catch(err => { console.error("MongoDB connection failed:", err.message); process.exit(1); });
