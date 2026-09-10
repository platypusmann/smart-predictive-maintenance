// Node-RED function node: rolling window + feature extraction
//
// Keeps the last 30 readings for each machine and every 10 readings sends on a
// feature vector. Same maths as packages/shared/src/features.js (copied in
// because function nodes can't require our own modules).
//
// After editing run: npm run flows:build

const WINDOW_SIZE = 30;
const STRIDE = 10;
const CHANNELS = ['vibration', 'temperature', 'current', 'rpm'];

function slope(values) {
    const n = values.length;
    if (n < 2) return 0;
    let xMean = 0;
    let yMean = 0;
    for (let i = 0; i < n; i++) { xMean += i; yMean += values[i]; }
    xMean /= n;
    yMean /= n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        const dx = i - xMean;
        num += dx * (values[i] - yMean);
        den += dx * dx;
    }
    return den === 0 ? 0 : num / den;
}

function extractFeatures(window, runtimeHours) {
    const vector = [];
    for (const channel of CHANNELS) {
        const series = window.map(function (r) { return Number(r[channel]); });
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        for (const v of series) {
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const mean = sum / series.length;
        let sq = 0;
        for (const v of series) { sq += (v - mean) * (v - mean); }
        vector.push(mean);
        vector.push(Math.sqrt(sq / series.length));
        vector.push(min);
        vector.push(max);
        vector.push(slope(series));
    }
    vector.push(Number(runtimeHours) || 0);
    return vector;
}

// --- node body ---------------------------------------------------------

const reading = msg.payload;
if (!reading || typeof reading.machineId !== 'string') {
    node.warn('dropping reading with no machineId');
    return null;
}

const windows = context.get('windows') || {};
const counters = context.get('counters') || {};

const buffer = windows[reading.machineId] || [];
buffer.push(reading);
if (buffer.length > WINDOW_SIZE) buffer.shift();
windows[reading.machineId] = buffer;

counters[reading.machineId] = (counters[reading.machineId] || 0) + 1;

// Not enough history yet, or the stride has not elapsed since the last emit.
if (buffer.length < WINDOW_SIZE || counters[reading.machineId] < STRIDE) {
    context.set('windows', windows);
    context.set('counters', counters);
    return null;
}

counters[reading.machineId] = 0;
context.set('windows', windows);
context.set('counters', counters);

node.status({ fill: 'green', shape: 'dot', text: Object.keys(windows).length + ' machines' });

msg.payload = {
    machineId: reading.machineId,
    machineType: reading.machineType,
    timestamp: reading.timestamp,
    runtimeHours: reading.runtimeHours,
    features: extractFeatures(buffer, reading.runtimeHours),
    raw: {
        vibration: reading.vibration,
        temperature: reading.temperature,
        current: reading.current,
        rpm: reading.rpm
    }
};
return msg;
