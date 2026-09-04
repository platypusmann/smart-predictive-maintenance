'use strict';

/**
 * Storage abstraction with two drivers.
 *
 *   memory : no database required. Used by the unit tests and by the load
 *            tests, where a shared Atlas cluster would otherwise be the
 *            bottleneck being measured instead of the services themselves.
 *   mongo  : MongoDB via Mongoose. Readings and predictions are time-series
 *            documents with a flexible schema; work orders are a small
 *            well-defined workflow collection.
 *
 * Services depend on this interface, never on Mongoose directly, so the
 * driver can be switched with STORE_DRIVER.
 */

class MemoryStore {
  constructor({ maxReadings = 200000 } = {}) {
    this.driver = 'memory';
    this.readings = [];
    this.predictions = [];
    this.workOrders = [];
    this.maxReadings = maxReadings;
    this.nextWorkOrderId = 1;
  }

  async connect() {
    return this;
  }

  async saveReading(doc) {
    this.readings.push(doc);
    // Bounded so a long load test cannot exhaust the heap.
    if (this.readings.length > this.maxReadings) {
      this.readings.splice(0, this.readings.length - this.maxReadings);
    }
    return doc;
  }

  async saveReadings(docs) {
    for (const doc of docs) await this.saveReading(doc);
    return docs.length;
  }

  async savePrediction(doc) {
    this.predictions.push(doc);
    if (this.predictions.length > this.maxReadings) {
      this.predictions.splice(0, this.predictions.length - this.maxReadings);
    }
    return doc;
  }

  async createWorkOrder(doc) {
    const record = { ...doc, _id: `wo_${this.nextWorkOrderId++}` };
    this.workOrders.push(record);
    return record;
  }

  async latestPredictions(limit = 50) {
    return [...this.predictions].slice(-limit).reverse();
  }

  async openWorkOrders(limit = 50) {
    return this.workOrders
      .filter((wo) => wo.status === 'open')
      .slice(-limit)
      .reverse();
  }

  async counts() {
    return {
      readings: this.readings.length,
      predictions: this.predictions.length,
      workOrders: this.workOrders.length,
    };
  }

  async close() {}
}

class MongoStore {
  constructor({ uri, dbName }) {
    this.driver = 'mongo';
    this.uri = uri;
    this.dbName = dbName;
    this.mongoose = null;
    this.models = {};
  }

  async connect() {
    // Required lazily so the memory driver has no Mongoose dependency at all.
    const mongoose = require('mongoose');
    this.mongoose = mongoose;

    // Connect once, at service start, outside any polling loop, and leave the
    // connection open for the lifetime of the process.
    await mongoose.connect(this.uri, {
      dbName: this.dbName,
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 20,
    });

    const { Schema } = mongoose;

    const readingSchema = new Schema(
      {
        machineId: { type: String, required: true, index: true },
        machineType: String,
        timestamp: { type: Date, required: true },
        runtimeHours: Number,
        vibration: Number,
        temperature: Number,
        current: Number,
        rpm: Number,
        features: [Number],
      },
      { collection: 'readings', versionKey: false }
    );
    readingSchema.index({ machineId: 1, timestamp: -1 });

    const predictionSchema = new Schema(
      {
        machineId: { type: String, required: true, index: true },
        timestamp: { type: Date, required: true },
        riskScore: { type: Number, required: true },
        predictedFailing: Boolean,
        modelVersion: String,
        inferenceLatencyMs: Number,
      },
      { collection: 'predictions', versionKey: false }
    );
    predictionSchema.index({ machineId: 1, timestamp: -1 });

    const workOrderSchema = new Schema(
      {
        machineId: { type: String, required: true, index: true },
        createdAt: { type: Date, required: true, default: Date.now },
        riskScore: Number,
        consecutiveBreaches: Number,
        status: {
          type: String,
          enum: ['open', 'acknowledged', 'closed'],
          default: 'open',
          index: true,
        },
        assignedTechnician: String,
        notes: String,
      },
      { collection: 'work_orders', versionKey: false }
    );

    // models are compiled once, guarded so repeated connects in tests are safe
    this.models.Reading =
      mongoose.models.Reading || mongoose.model('Reading', readingSchema);
    this.models.Prediction =
      mongoose.models.Prediction || mongoose.model('Prediction', predictionSchema);
    this.models.WorkOrder =
      mongoose.models.WorkOrder || mongoose.model('WorkOrder', workOrderSchema);

    return this;
  }

  async saveReading(doc) {
    return this.models.Reading.create(doc);
  }

  async saveReadings(docs) {
    if (docs.length === 0) return 0;
    // Unordered so one bad document does not abort the whole batch.
    await this.models.Reading.insertMany(docs, { ordered: false });
    return docs.length;
  }

  async savePrediction(doc) {
    return this.models.Prediction.create(doc);
  }

  async createWorkOrder(doc) {
    return this.models.WorkOrder.create(doc);
  }

  async latestPredictions(limit = 50) {
    return this.models.Prediction.find().sort({ timestamp: -1 }).limit(limit).lean();
  }

  async openWorkOrders(limit = 50) {
    return this.models.WorkOrder.find({ status: 'open' })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  async counts() {
    const [readings, predictions, workOrders] = await Promise.all([
      this.models.Reading.estimatedDocumentCount(),
      this.models.Prediction.estimatedDocumentCount(),
      this.models.WorkOrder.estimatedDocumentCount(),
    ]);
    return { readings, predictions, workOrders };
  }

  async close() {
    if (this.mongoose) await this.mongoose.disconnect();
  }
}

function createStore(config) {
  if (config.storeDriver === 'mongo') {
    if (!config.mongoUri) {
      throw new Error('STORE_DRIVER=mongo requires MONGO_URI to be set');
    }
    return new MongoStore({ uri: config.mongoUri, dbName: config.mongoDbName });
  }
  return new MemoryStore();
}

module.exports = { createStore, MemoryStore, MongoStore };
