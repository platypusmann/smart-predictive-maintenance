// Node-RED function node: batch up feature vectors (25 at a time or every 2s)
// so we're not doing one HTTP request per vector.
//
// After editing run: npm run flows:build

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
