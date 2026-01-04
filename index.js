const express = require("express");
const { MongoClient, ServerApiVersion } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

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
