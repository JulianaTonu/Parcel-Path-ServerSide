const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;
const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);
console.log('PAYMENT_GATEWAY_KEY', process.env.PAYMENT_GATEWAY_KEY)
// ✅ CORS (Express 5 compatible)
app.use(cors({
  origin: "http://localhost:5173",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

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


    app.post("/parcels", async (req, res) => {
      try {
        const result = await parcelsCollection.insertOne(req.body);
        res.send({ success: true, insertedId: result.insertedId });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Insert failed" });
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
          createdAt: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(payment);

        // 2️⃣ Mark parcel as paid
        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              paid: true,
              transactionId,
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
