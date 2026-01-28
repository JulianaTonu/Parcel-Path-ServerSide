const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;
const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);

// ✅ CORS (Express 5 compatible)
app.use(cors({
  origin: "http://localhost:5173",
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());
const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.clv6xgk.mongodb.net/${process.env.DB_NAME}?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("✅ MongoDB Connected");

    const database = client.db(process.env.DB_NAME);
    const parcelsCollection = database.collection("parcels");
    const paymentsCollection = database.collection("payments");
    const trackingCollection = database.collection("tracking");
    const usersCollection = database.collection("users");
    const ridersCollection = database.collection("riders");
    const riderEarningsCollection = database.collection("riderEarnings");

    //custom middlewares
    const verifyFBToken = async (req, res, next) => {
      console.log('header in middleware', req.headers)
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: 'unauthorized access' })
      }
      const token = authHeader.split(' ')[1]
      if (!token) {
        return res.status(401).send({ message: 'unauthorized access' })
      }


      // verify the token 
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();

      } catch (error) {
        return res.status(403).send({ message: 'forbidden access' })
      }

    }

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Admin access only" });
      }

      next();
    };

    const verifyRider = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.decoded.email });
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "Rider only" });
      }
      next();
    };


    // Get users count by role (user / rider / admin)
    app.get("/users/count/:role", async (req, res) => {
      const role = req.params.role;

      if (!role) {
        return res.status(400).send({ message: "Role is required" });
      }

      const count = await usersCollection.countDocuments({ role });
      res.send({ role, total: count });
    });


    // 🔍 Search users by email (partial match)
    app.get("/users/search", async (req, res) => {
      const { q } = req.query;

      if (!q) return res.send([]);

      const users = await usersCollection
        .find({
          email: { $regex: q, $options: "i" } // case-insensitive partial match
        })
        .limit(5) // optional: limit results
        .toArray();

      res.send(users);
    });

    // Get user role by email
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const user = await usersCollection.findOne(
        { email },
        { projection: { role: 1, email: 1 } }
      );

      if (!user) {
        return res.status(404).send({ role: "user" });
      }

      res.send({ role: user.role || "user" });
    });


    // Update user role
    app.patch('/users/role/:id', verifyFBToken, async (req, res) => {
      const { role } = req.body;

      if (!['admin', 'user'].includes(role)) {
        return res.status(400).send({ message: 'Invalid role' });
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { role } }
      );

      res.send(result);
    });

    // Get user profile for dashboard
    app.get("/users/profile/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const user = await usersCollection.findOne(
        { email },
        {
          projection: {
            name: 1,
            email: 1,
            photoURL: 1,
            phone: 1,
            role: 1,
            createdAt: 1,
          },
        }
      );

      if (!user) {
        return res.status(404).send({ message: "User not found" });
      }

      res.send(user);
    });
    // Update user profile (name, contact, photoURL)
    app.patch("/users/profile/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const { name, contact, photoURL } = req.body;

      if (!name && !contact && !photoURL) {
        return res.status(400).send({ message: "Nothing to update" });
      }

      const updateDoc = {
        $set: {
          ...(name && { name }),
          ...(contact && { contact }),
          ...(photoURL && { photoURL }),
        },
      };

      const result = await usersCollection.updateOne(
        { email },
        updateDoc
      );

      res.send({
        success: result.modifiedCount > 0,
        message: "Profile updated successfully",
      });
    });

    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        const result = await usersCollection.insertOne(user);
        res.send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res.status(500).send({ message: "User save failed" });
      }
    });

    // Social login: first-time or returning user
    app.post("/users/social-login", async (req, res) => {
      try {
        const { name, email, uid, photoURL } = req.body;

        if (!email || !uid) {
          return res.status(400).send({ message: "Email and UID are required" });
        }

        // Check if user already exists (by email or UID)
        let user = await usersCollection.findOne({
          $or: [{ email }, { uid }],
        });

        if (!user) {
          // First-time login → create new user
          const newUser = {
            name,
            email,
            uid,
            photoURL,
            role: "user", // default role
            createdAt: new Date(),
            lastLogin: new Date(),
          };

          const result = await usersCollection.insertOne(newUser);
          user = { ...newUser, _id: result.insertedId };
          console.log("New social user created:", user);
        } else {
          // Returning user → update last login
          await usersCollection.updateOne(
            { _id: user._id },
            { $set: { lastLogin: new Date() } }
          );
          console.log("Returning social user:", user);
        }

        res.send(user);
      } catch (error) {
        console.error("Social login error:", error);
        res.status(500).send({ message: "Social login failed" });
      }
    });


    // PARCEL CREATE (EMAIL SAFE + AUTO TRACKING)
    // ====================================================== */
    app.post("/parcels", async (req, res) => {
      try {
        const parcel = {
          ...req.body,
          payment_status: "unpaid",
          trackingId: `TRK-${Date.now()}`,
          creation_date: new Date(),
        };

        const parcelResult = await parcelsCollection.insertOne(parcel);

        //  AUTO TRACKING CREATE
        const tracking = {
          parcelId: parcelResult.insertedId,
          trackingId: parcel.trackingId,
          status: "Parcel Created",
          location: "Warehouse",
          message: "Parcel has been registered",
          createdAt: new Date(),
        };

        await trackingCollection.insertOne(tracking);

        res.send({
          success: true,
          parcelId: parcelResult.insertedId,
          trackingId: tracking.trackingId,
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Parcel creation failed" });
      }
    });


    // Parcel api
    ///Get: all parcel or parcels by user(created_by),sorted by latest
    app.get("/parcels", async (req, res) => {
      try {
        const { email } = req.query;

        let query = {};

        // If email is provided → get user parcels
        if (email) {
          query.created_by = email;
        }

        const parcels = await parcelsCollection
          .find(query)
          .sort({ creation_date: -1 }) // latest first
          .toArray();

        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to fetch parcels" });
      }
    });

    //GET :get a specific parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;

      // validate ObjectId
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid parcel ID" });
      }

      try {
        const query = { _id: new ObjectId(id) };
        const parcel = await parcelsCollection.findOne(query);



        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }
        res.send(parcel);

      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // DELETE parcel by id
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send({
          success: result.deletedCount > 0,
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ success: false });
      }
    });

    // ======  RIDER  =====

    // GET pending riders
    app.get('/riders', async (req, res) => {
      const status = req.query.status;
      const query = status ? { status } : {};
      const riders = await ridersCollection.find(query).toArray();
      res.send(riders);
    });

    // Update rider status
    app.patch('/riders/:id', async (req, res) => {
      const { status } = req.body;
      const riderId = req.params.id;

      // 1️⃣ Update rider status
      const rider = await ridersCollection.findOne({
        _id: new ObjectId(riderId),
      });

      if (!rider) {
        return res.status(404).send({ message: "Rider not found" });
      }

      const result = await ridersCollection.updateOne(
        { _id: new ObjectId(riderId) },
        { $set: { status } }
      );

      // 2️⃣ IF approved → update user role
      if (status === "active") {
        await usersCollection.updateOne(
          { email: rider.email },
          { $set: { role: "rider" } }
        );
      }

      // 3️⃣ IF rejected → optional rollback
      if (status === "rejected") {
        await usersCollection.updateOne(
          { email: rider.email },
          { $set: { role: "user" } }
        );
      }

      res.send(result);
    });


    //Create Rider 
    app.post('/riders', async (req, res) => {
      const rider = req.body;

      if (!rider.email) {
        return res.status(400).send({ message: 'Email required' });
      }

      const exists = await ridersCollection.findOne({ email: rider.email });
      if (exists) {
        return res.status(409).send({ message: 'Already applied' });
      }

      const result = await ridersCollection.insertOne({
        ...rider,
        status: 'pending',
        created_at: new Date()
      });

      res.send({ insertedId: result.insertedId });
    });


    // ======== ASSIGN RIDER =====
    app.put("/parcels/:id/assign-rider", async (req, res) => {
      try {
        const parcelId = req.params.id;
        const { rider } = req.body;

        if (!rider) {
          return res.status(400).json({ message: "Rider name is required" });
        }

        // 1️⃣ Find parcel
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).json({ message: "Parcel not found" });
        }

        // 2️⃣ Find rider
        const riderData = await ridersCollection.findOne({ name: rider });

        if (!riderData) {
          return res.status(404).json({ message: "Rider not found" });
        }

        // 3️⃣ Update parcel
        await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              rider: riderData.name,
              riderEmail: riderData.email,
              riderPhone: riderData.contact,
              delivery_status: "In Transit",
              assignedAt: new Date(),
            },
          }
        );

        // 4️⃣ Update rider work status
        await ridersCollection.updateOne(
          { _id: riderData._id },
          { $set: { work_status: "In Delivery" } }
        );

        // 5️⃣ Tracking entry
        await trackingCollection.insertOne({
          trackingId: parcel.trackingId,
          status: "Rider Assigned",
          message: `Rider ${riderData.name} assigned. Parcel is now in transit.`,
          location: "Warehouse",
          createdAt: new Date(),
        });

        res.json({ success: true, message: "Rider assigned successfully" });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to assign rider" });
      }
    });

    // ======== RIDER PENDING PARCELS ====
    app.get("/rider/pending-parcels", verifyFBToken, verifyRider,
      async (req, res) => {
        const email = req.query.email;
        console.log('riderEmail', email)
        console.log('decoded', req.decoded.email)
        // security check
        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const parcels = await parcelsCollection.find({
          riderEmail: email,
          delivery_status: "In Transit",
        }).toArray();

        res.send(parcels);
      }
    );



    const RIDER_COMMISSION_PERCENT = 20;
    // ===== RIDER DELIVER PARCEL =====
    app.patch("/parcels/:id/deliver", verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const parcelId = req.params.id;

          const parcel = await parcelsCollection.findOne({
            _id: new ObjectId(parcelId),
          });

          if (!parcel) {
            return res.status(404).send({ message: "Parcel not found" });
          }

          if (parcel.delivery_status === "Delivered") {
            return res.status(400).send({ message: "Parcel already delivered" });
          }

          if (parcel.riderEmail !== req.decoded.email) {
            return res.status(403).send({ message: "Forbidden access" });
          }

          // 💰 rider earning
          const riderEarning = Math.round(
            (parcel.delivery_cost * RIDER_COMMISSION_PERCENT) / 100
          );

          const isCOD = parcel.payment_status === "unpaid";

          // 1️⃣ Update parcel
          await parcelsCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            {
              $set: {
                delivery_status: "Delivered",
                deliveredAt: new Date(),
                riderEarning,
                payment_status: isCOD ? "paid" : parcel.payment_status,
              },
            }
          );

          // 2️⃣ Insert earning record
          await riderEarningsCollection.insertOne({
            riderEmail: parcel.riderEmail,
            parcelId: parcel.trackingId,
            totalCost: parcel.delivery_cost,
            amount: riderEarning,
            type: isCOD ? "COD" : "ONLINE",
            status: isCOD ? "cashed_out" : "pending",
            createdAt: new Date(),
          });

          // 3️⃣ Tracking
          await trackingCollection.insertOne({
            trackingId: parcel.trackingId,
            status: "Delivered",
            message: isCOD
              ? "Parcel delivered & cash collected"
              : "Parcel delivered successfully",
            location: parcel.receiver_district || "Destination",
            createdAt: new Date(),
          });

          res.send({
            success: true,
            riderEarning,
            cashed_out: isCOD ? riderEarning : 0,
          });
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Delivery update failed" });
        }
      }
    );

    // ======== RIDER COMPLETED DELIVERED (get delivered parcel) ========
    app.get("/rider/completed-parcels", verifyFBToken, verifyRider,
      async (req, res) => {
        try {
          const email = req.query.email;

          //  security check
          if (req.decoded.email !== email) {
            return res.status(403).send({ message: "Forbidden access" });
          }

          const parcels = await parcelsCollection
            .find({
              riderEmail: email,
              delivery_status: "Delivered",
            })
            .sort({ deliveredAt: -1 }) // latest delivered first
            .toArray();

          res.send(parcels);
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Failed to fetch completed deliveries" });
        }
      }
    );


    // ===== GET rider profile =====
    // ===== GET rider profile =====
app.get("/rider/profile", verifyFBToken, verifyRider, async (req, res) => {
  try {
    const email = req.decoded.email;

    const rider = await ridersCollection.findOne({ email });
    if (!rider) return res.status(404).send({ message: "Rider not found" });

    const user = await usersCollection.findOne({ email });

    const earnings = await riderEarningsCollection
      .find({ riderEmail: email })
      .toArray();

    const totalEarning = earnings.reduce((s, e) => s + e.amount, 0);

    // ✅ CORRECT DELIVERY COUNT
    const totalDeliveries = await parcelsCollection.countDocuments({
      riderEmail: email,
      delivery_status: "Delivered",
    });

    res.send({
      user: {
        name: rider.name,
        email: rider.email,
        phone: rider.contact,
        district: rider.district,
        photoURL: user?.photoURL,
        createdAt: rider.created_at,
      },
      totalEarning,
      totalDeliveries,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to fetch profile" });
  }
});

    // ===== Cashout =====
    app.post("/rider/cashout", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.decoded.email;

        const pendingEarnings = await riderEarningsCollection.find({
          riderEmail: email,
          status: "pending"
        }).toArray();

        if (!pendingEarnings.length) {
          return res.status(400).send({ message: "No pending earnings" });
        }

        const total = pendingEarnings.reduce((sum, e) => sum + e.amount, 0);

        const ids = pendingEarnings.map(e => e._id);

        await riderEarningsCollection.updateMany(
          { _id: { $in: ids } },
          {
            $set: {
              status: "cashed_out",
              cashedOutAt: new Date(),
            }
          }
        );

        res.send({ success: true, cashedOut: total });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Cashout failed" });
      }
    });

    // ====== Earnings Summary ======
    app.get("/rider/earnings-summary", verifyFBToken, verifyRider,
      async (req, res) => {
        try {
          const email = req.decoded.email;

          const earnings = await riderEarningsCollection
            .find({ riderEmail: email })
            .toArray();

          const now = new Date();

          const startOfToday = new Date();
          startOfToday.setHours(0, 0, 0, 0);

          // Monday start of week
          const startOfWeek = new Date();
          const day = startOfWeek.getDay() || 7;
          startOfWeek.setDate(startOfWeek.getDate() - day + 1);
          startOfWeek.setHours(0, 0, 0, 0);

          const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
          const startOfYear = new Date(now.getFullYear(), 0, 1);

          const sumAmount = (list) =>
            list.reduce((sum, e) => sum + e.amount, 0);

          const totalEarning = sumAmount(earnings);

          const cashedOut = sumAmount(
            earnings.filter(e => e.status === "cashed_out")
          );

          const pending = totalEarning - cashedOut;

          const today = sumAmount(
            earnings.filter(e => new Date(e.createdAt) >= startOfToday)
          );

          const thisWeek = sumAmount(
            earnings.filter(e => new Date(e.createdAt) >= startOfWeek)
          );

          const thisMonth = sumAmount(
            earnings.filter(e => new Date(e.createdAt) >= startOfMonth)
          );

          const thisYear = sumAmount(
            earnings.filter(e => new Date(e.createdAt) >= startOfYear)
          );

          res.send({
            totalEarning,
            cashedOut,
            pending,
            today,
            thisWeek,
            thisMonth,
            thisYear,
          });
        } catch (error) {
          console.error("Earnings summary error:", error);
          res.status(500).send({ message: "Failed to fetch earnings summary" });
        }
      }
    );


    //===My Earnings List API===
    app.get("/rider/earnings", verifyFBToken, verifyRider,
      async (req, res) => {
        const email = req.decoded.email;

        const result = await riderEarningsCollection
          .find({ riderEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      }
    );



    //=== GET PARCEL BY Tracking ID ===
    app.get("/parcels/by-tracking/:trackingId", async (req, res) => {
      try {
        const trackingId = req.params.trackingId.trim();

        const parcel = await parcelsCollection.findOne({ trackingId });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel by trackingId:", error);
        res.status(500).send({ message: "Server error" });
      }
    });


    // GET tracking history by trackingId
    app.get('/tracking/:trackingId', async (req, res) => {
      try {
        const { trackingId } = req.params;

        const trackingHistory = await trackingCollection
          .find({ trackingId: trackingId.trim() })
          .sort({ createdAt: -1 })
          .toArray();

        // ✅ even if empty → return 200 + []
        res.send(trackingHistory);
      } catch (error) {
        console.error('Tracking fetch error:', error);
        res.status(500).send({ message: 'Failed to fetch tracking data' });
      }
    });





    app.post('/tracking/update', async (req, res) => {
      try {
        const update = {
          parcelId: new ObjectId(req.body.parcelId),
          trackingId: req.body.trackingId,
          status: req.body.status,
          location: req.body.location,
          message: req.body.message,
          createdAt: new Date()
        };

        const result = await trackingCollection.insertOne(update);
        res.send({ success: true });
      } catch (error) {
        res.status(500).send({ message: 'Tracking update failed' });
      }
    });

    //payment-intent
    app.post('/create-payment-intent', async (req, res) => {
      try {
        const { amount } = req.body; // get amount from request
        const paymentIntent = await stripe.paymentIntents.create({
          amount, // amount in cents
          currency: 'usd',
          payment_method_types: ['card'],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    //>>>>>>>PayMent.<<<<<<<

    // GET: payment history (by user or all for admin)
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const { email } = req.query;
        console.log('decoded', req.decoded.email)
        if (req.decoded.email !== email) {
          return res.status(403).send({ message: 'forbidden access' })
        }

        let query = {};

        // If email is provided → get payments by user
        if (email) {
          query.email = email;
        }

        const payments = await paymentsCollection
          .find(query)
          .sort({ createdAt: -1 }) // ✅ latest first
          .toArray();
        console.log('payments', payments)
        res.send(payments);
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).send({ message: "Failed to fetch payment history" });
      }
    });


    // ========= PAYMENT =========
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, transactionId } = req.body;

        // 1️⃣ Find parcel (optional but recommended)
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        // 2️⃣ Save payment history
        const payment = {
          parcelId: new ObjectId(parcelId),
          email,
          amount,
          transactionId,
          status: "succeeded",
          createdAt: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(payment);

        // 3️⃣ Mark parcel as PAID (❗ delivery status untouched)
        await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
            },
          }
        );

        // 4️⃣ Tracking entry ONLY for payment
        await trackingCollection.insertOne({
          trackingId: parcel.trackingId,
          status: "Payment Received",
          message: "Payment completed successfully",
          location: "Online Payment",
          createdAt: new Date(),
        });

        res.send({
          success: true,
          paymentId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment error:", error);
        res.status(500).send({ message: "Payment save failed" });
      }
    });



    // Rider delivery statistics (area wise)
app.get("/rider/stats/areas", verifyFBToken, verifyRider, async (req, res) => {
  const riderEmail = req.decoded.email;

  const result = await parcelsCollection.aggregate([
    {
      $match: {
        riderEmail,
        delivery_status: "Delivered",
      },
    },
    {
      $group: {
        _id: "$receiver_service_area",
        total: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        area: "$_id",
        value: "$total",
      },
    },
  ]).toArray();

  res.send(result);
});

// Get parcel count by delivery_status
app.get("/parcels/count/:status", async (req, res) => {
  let status = req.params.status.replace("-", " "); // URL-safe
  const total = await parcelsCollection.countDocuments({ delivery_status: status });
  res.send({ status, total });
});

// ===== REVENUE =====

// Total revenue from paid parcels
app.get("/revenue", async (req, res) => {
  const result = await parcelsCollection.aggregate([
    { $match: { payment_status: "paid" } },
    { $group: { _id: null, totalRevenue: { $sum: "$delivery_cost" } } },
  ]).toArray();

  res.send({ totalRevenue: result[0]?.totalRevenue || 0 });
});


app.get(
  "/rider/stats/deliveries",
  verifyFBToken,
  verifyRider,
  async (req, res) => {
    try {
      const riderEmail = req.decoded.email;

      const result = await parcelsCollection.aggregate([
        {
          $match: {
            riderEmail: riderEmail,
            delivery_status: "Delivered"  || "In Transit",
            deliveredAt: { $exists: true }
          }
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%b %d",
                date: "$deliveredAt"
              }
            },
            deliveries: { $sum: 1 }
          }
        },
        { $sort: { "_id": 1 } },
        {
          $project: {
            _id: 0,
            date: "$_id",
            deliveries: 1
          }
        }
      ]).toArray();

      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send({ message: "Failed to load delivery stats" });
    }
  }
);




  } catch (err) {
    console.error(err);
  }
}
run();

app.get("/", (req, res) => {
  res.send("ParcelPath Server is Running 🚚");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
