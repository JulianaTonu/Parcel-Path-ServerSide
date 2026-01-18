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
  methods: ["GET", "POST", "PUT", "DELETE",],
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
          creation_date: new Date(),
        };

        const parcelResult = await parcelsCollection.insertOne(parcel);

        //  AUTO TRACKING CREATE
        const tracking = {
          parcelId: parcelResult.insertedId,
          trackingId: `TRK-${Date.now()}`,
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

    // GET pending riders
    app.get('/riders',  async (req, res) => {
      const status = req.query.status;
      const query = status ? { status } : {};
      const riders = await ridersCollection.find(query).toArray();
      res.send(riders);
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


    // GET tracking history by trackingId
    app.get('/tracking/:trackingId', async (req, res) => {
      try {
        const { trackingId } = req.params;

        const trackingHistory = await trackingCollection
          .find({ trackingId })
          .sort({ createdAt: 1 }) // oldest → latest (timeline)
          .toArray();

        if (trackingHistory.length === 0) {
          return res.status(404).send([]);
        }

        res.send(trackingHistory);
      } catch (error) {
        console.error('Tracking fetch error:', error);
        res.status(500).send({ message: 'Failed to fetch tracking data' });
      }
    });

    // Tracking ID diye parcel pabar jonne:
    app.get("/parcels/by-tracking/:trackingId", async (req, res) => {
      const { trackingId } = req.params;

      const tracking = await trackingCollection.findOne({ trackingId });
      if (!tracking) return res.status(404).send({});

      const parcel = await parcelsCollection.findOne({
        _id: tracking.parcelId,
      });

      res.send(parcel);
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
        console.log('decoded', req.decoded)
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

        res.send(payments);
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).send({ message: "Failed to fetch payment history" });
      }
    });


    //PayMent
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, transactionId } = req.body;

        // 1️⃣ Save payment history
        const payment = {
          parcelId: new ObjectId(parcelId),
          email,
          amount,
          transactionId,
          status: "succeeded",
          created_at_string: new Date().toISOString(),
          createdAt: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(payment);

        // 2️⃣ Mark parcel as paid
        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: 'paid',
            },
          }
        );

        res.send({
          success: true,
          paymentId: paymentResult.insertedId,
          parcelUpdated: parcelUpdate.modifiedCount > 0,
        });

      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Payment save failed" });
      }

    });




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
