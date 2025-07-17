const express = require("express");
const cors = require("cors");
const duckdb = require("duckdb");
const basicAuth = require("express-basic-auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const port = 5050;

// ========== FILE UPLOAD SETUP ==========
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `txn-${unique}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage });

// ========== MIDDLEWARE ==========
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3003",
      "https://backend-road-transport.onrender.com",
      "https://ministry-transport.onrender.com",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use("/uploads", express.static(uploadDir)); // Serve uploads

// ========== DUCKDB INIT ==========
const db = new duckdb.Database("bookings.db");

db.exec(
  `
  CREATE TABLE IF NOT EXISTS booking_details (
    id INTEGER,
    state TEXT,
    wheelerRegNo TEXT,
    chassisNo TEXT,
    engineNo TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_details (
    id INTEGER,
    booking_id INTEGER,
    name TEXT,
    email TEXT,
    phone TEXT,
    delivery_address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS payment_details (
    id INTEGER,
    booking_id INTEGER,
    payment_amount DECIMAL(10,2),
    payment_status TEXT,
    transaction_id TEXT,
    transaction_screenshot TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`,
  (err) => {
    if (err) {
      console.error("❌ DB Setup Error:", err);
      process.exit(1);
    }
    console.log("✅ Tables created/verified");
    startServer();
  }
);

// ========== API ROUTES ==========

// STEP 1: Save booking details
app.post("/api/booking-details", (req, res) => {
  const { state, wheelerRegNo, chassisNo, engineNo } = req.body;
  if (!state || !wheelerRegNo || !chassisNo || !engineNo)
    return res.status(400).json({ error: "All fields are required" });

  db.all(
    "SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM booking_details",
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });

      const nextId = rows[0].nextId;
      const stmt = db.prepare(`
      INSERT INTO booking_details (id, state, wheelerRegNo, chassisNo, engineNo)
      VALUES (?, ?, ?, ?, ?)
    `);
      stmt.run(nextId, state, wheelerRegNo, chassisNo, engineNo, (err) => {
        if (err) return res.status(500).json({ error: "Insert failed" });
        res.json({
          message: "✅ Booking information saved successfully",
          bookingId: nextId,
        });
      });
    }
  );
});

// STEP 2: Save user details
app.post("/api/user-details", (req, res) => {
  const { name, email, phone, delivery_address, bookingId } = req.body;
  if (!bookingId || !name || !phone || !delivery_address)
    return res.status(400).json({ error: "Missing fields." });

  db.all(
    "SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM user_details",
    (err, rows) => {
      if (err) return res.status(500).json({ error: "User ID error" });

      const nextId = rows[0].nextId;
      const stmt = db.prepare(`
      INSERT INTO user_details (id, booking_id, name, email, phone, delivery_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
      stmt.run(
        nextId,
        bookingId,
        name,
        email,
        phone,
        delivery_address,
        (err) => {
          if (err) return res.status(500).json({ error: "Insert failed" });
          res.json({
            message: "✅ User information saved successfully",
            bookingId,
          });
        }
      );
    }
  );
});

// STEP 3: Save payment info with screenshot
app.post(
  "/api/payment-details",
  upload.single("transaction_screenshot"),
  (req, res) => {
    const { bookingId, payment_amount } = req.body;
    const screenshot = req.file ? `/uploads/${req.file.filename}` : null;

    if (!bookingId || !payment_amount)
      return res.status(400).json({ error: "Missing payment info" });

    db.all(
      "SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM payment_details",
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Payment ID error" });

        const nextId = rows[0].nextId;
        const txnId = "TXN" + Date.now();

        const stmt = db.prepare(`
      INSERT INTO payment_details (id, booking_id, payment_amount, payment_status, transaction_id, transaction_screenshot)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
        stmt.run(
          nextId,
          bookingId,
          payment_amount,
          "completed",
          txnId,
          screenshot,
          (err) => {
            if (err) return res.status(500).json({ error: "Insert failed" });
            res.json({
              message: "✅ Payment details submitted successfully",
              bookingId,
            });
          }
        );
      }
    );
  }
);

// ========== ADMIN PANEL ==========

app.use(
  "/admin",
  basicAuth({
    users: { admin: "admin123" },
    challenge: true,
  })
);

app.get("/admin", (req, res) => {
  db.all(
    `SELECT
      bd.*, ud.name, ud.email, ud.phone, ud.delivery_address,
      pd.payment_amount, pd.payment_status, pd.transaction_screenshot
    FROM booking_details bd
    LEFT JOIN user_details ud ON bd.id = ud.booking_id
    LEFT JOIN payment_details pd ON bd.id = pd.booking_id
    ORDER BY bd.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).send("DB fetch error");

      let html = `<h1>Booking Records</h1><table border="1" cellpadding="6"><tr>
        <th>ID</th><th>State</th><th>RegNo</th><th>Chassis</th><th>Engine</th>
        <th>Name</th><th>Phone</th><th>Email</th><th>Address</th>
        <th>Amount</th><th>Status</th><th>Screenshot</th><th>Created</th>
      </tr>`;
      rows.forEach((r) => {
        html += `<tr>
          <td>${r.id}</td><td>${r.state}</td><td>${r.wheelerRegNo}</td><td>${
          r.chassisNo
        }</td><td>${r.engineNo}</td>
          <td>${r.name || "-"}</td><td>${r.phone || "-"}</td><td>${
          r.email || "-"
        }</td><td>${r.delivery_address || "-"}</td>
          <td>${r.payment_amount || "-"}</td><td>${r.payment_status || "-"}</td>
          <td>${
            r.transaction_screenshot
              ? `<a href="${r.transaction_screenshot}" target="_blank">View</a>`
              : "-"
          }</td>
          <td>${r.created_at}</td>
        </tr>`;
      });
      html += `</table>`;
      res.send(html);
    }
  );
});

// ========== SERVER START ==========
function startServer() {
  app.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
  });
}
