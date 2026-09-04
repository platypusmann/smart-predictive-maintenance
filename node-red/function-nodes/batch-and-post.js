// Node-RED function node: batch feature vectors before posting to ingestion
//
// One HTTP request per feature vector would create a request per machine every
// 10 seconds, which becomes the dominant cost long before the microservices are
// under any real pressure. Batching amortises the request overhead and matches
// the batch API the ingestion service exposes.
//
// Build into flows.json with: npm run flows:build

const BATCH_SIZE = 25;
const MAX_AGE_MS = 2000;

const batch = context.get('batch') || [];
const firstSeenAt = context.get('firstSeenAt') || Date.now();

batch.push(msg.payload);

const isFull = batch.length >= BATCH_SIZE;
const isStale = Date.now() - firstSeenAt >= MAX_AGE_MS;

if (!isFull && !isStale) {
    context.set('batch', batch);
    context.set('firstSeenAt', firstSeenAt);
    node.status({ fill: 'blue', shape: 'ring', text: 'buffering ' + batch.length });
    return null;
}

context.set('batch', []);
context.set('firstSeenAt', Date.now());
node.status({ fill: 'green', shape: 'dot', text: 'sent ' + batch.length });

msg.headers = {
    'content-type': 'application/json',
    'x-api-key': env.get('PDM_API_KEY') || 'local-dev-key'
};
msg.payload = { readings: batch };
return msg;
