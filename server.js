require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FEE = Number(process.env.FEE_AMOUNT) || 100; // rupees
const UPI_ID = (process.env.UPI_ID || '').trim();
const PAYEE = process.env.PAYEE_NAME || 'Hareesh IT Industry';

const Student = mongoose.model('Student', new mongoose.Schema({
  name:    { type: String, required: true, trim: true, maxlength: 80 },
  contact: { type: String, required: true, match: /^[6-9]\d{9}$/ },
  email:   { type: String, required: true, trim: true, lowercase: true, unique: true,
             match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  college: { type: String, required: true, trim: true, maxlength: 120 },
  year:    { type: Number, required: true, enum: [1, 2, 3, 4] },
  utr:     { type: String, required: true, trim: true, uppercase: true, unique: true, sparse: true,
             match: /^[A-Z0-9]{10,25}$/ },          // UPI transaction ID / UTR entered by the student
  amount:  Number,                                   // rupees
  status:  { type: String, enum: ['pending', 'paid'], default: 'pending' }, // paid = verified by admin
  paidAt:  Date                                      // when the admin verified it
}, { timestamps: true }));

function isAdmin(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) return false;
  const a = Buffer.from(req.get('x-admin-key') || ''), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Public: payment details for the form (UPI ID, amount, QR) ----
const upiLink = () => 'upi://pay?pa=' + encodeURIComponent(UPI_ID) +
  '&pn=' + encodeURIComponent(PAYEE) + '&am=' + FEE.toFixed(2) +
  '&cu=INR&tn=' + encodeURIComponent('Cricket Registration');
let qrCache;

app.get('/api/payment-info', async (req, res) => {
  if (!UPI_ID) return res.status(500).json({ error: 'Payment details are not configured yet.' });
  try {
    qrCache = qrCache || await QRCode.toDataURL(upiLink(), { width: 300, margin: 1 });
    res.json({ fee: FEE, upiId: UPI_ID, payeeName: PAYEE, qr: qrCache, link: upiLink() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load payment details.' });
  }
});

// ---- Public: register (details + UPI transaction ID); stays "pending" until the admin verifies ----
app.post('/api/register', async (req, res) => {
  try {
    const { name, contact, email, college, year, utr } = req.body;
    await Student.create({
      name, contact, email, college, year: Number(year),
      utr: String(utr || '').trim(), amount: FEE, status: 'pending'
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0];
      return res.status(409).json({ error: field === 'utr'
        ? 'This transaction ID has already been used.'
        : 'This email is already registered.' });
    }
    if (err.name === 'ValidationError')
      return res.status(400).json({ error: 'Please check all fields (10-digit mobile number and a valid transaction ID).' });
    console.error(err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---- Admin only ----
app.get('/api/students', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Invalid admin key.' });
  const students = await Student.find().sort({ createdAt: -1 }).lean();
  const paid = students.filter(s => s.status === 'paid');
  res.json({
    total: paid.length,
    pending: students.length - paid.length,
    collected: paid.reduce((n, s) => n + (s.amount || 0), 0),
    students: students.map(s => ({
      id: s._id, name: s.name, contact: s.contact, email: s.email,
      college: s.college, year: s.year, utr: s.utr || '',
      status: s.status === 'paid' ? 'paid' : 'pending',
      registeredAt: s.createdAt
    }))
  });
});

app.patch('/api/students/:id/verify', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Invalid admin key.' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
  const s = await Student.findByIdAndUpdate(req.params.id, { status: 'paid', paidAt: new Date() }, { new: true });
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  res.json({ ok: true });
});

app.delete('/api/students/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Invalid admin key.' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
  const removed = await Student.findByIdAndDelete(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Student not found.' });
  res.json({ ok: true });
});

if (!process.env.ADMIN_KEY) console.warn('WARNING: ADMIN_KEY is not set. The admin page will be inaccessible.');
if (!UPI_ID) console.warn('WARNING: UPI_ID is not set. The payment step will not work.');

const port = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URI)
  .then(() => app.listen(port, () => console.log('Running on port ' + port)))
  .catch(err => { console.error('MongoDB connection failed:', err.message); process.exit(1); });
