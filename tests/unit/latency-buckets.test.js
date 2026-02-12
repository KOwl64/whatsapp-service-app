/**
 * Unit Tests: Latency Buckets
 */

const assert = require('assert');

// Import the latency bucket logic (we'll test the function directly)
function createLatencyBuckets() {
    const buckets = {
        '0-100': 0,
        '100-500': 0,
        '500ms-1s': 0,
        '1-5s': 0,
        '5-10s': 0,
        '10s+': 0
    };

    function addLatency(ms) {
        if (ms < 100) buckets['0-100']++;
        else if (ms < 500) buckets['100-500']++;
        else if (ms < 1000) buckets['500ms-1s']++;
        else if (ms < 5000) buckets['1-5s']++;
        else if (ms < 10000) buckets['5-10s']++;
        else buckets['10s+']++;
    }

    function getBuckets() {
        return { ...buckets };
    }

    function getSummary(latencies) {
        if (latencies.length === 0) {
            return {
                buckets,
                mean: 0,
                p50: 0,
                p95: 0,
                p99: 0
            };
        }

        const sorted = [...latencies].sort((a, b) => a - b);
        const n = sorted.length;

        return {
            buckets,
            mean: sorted.reduce((a, b) => a + b, 0) / n,
            p50: sorted[Math.floor(n * 0.50)],
            p95: sorted[Math.floor(n * 0.95)],
            p99: sorted[Math.floor(n * 0.99)]
        };
    }

    return { addLatency, getBuckets, getSummary };
}

// Test Suite
console.log('Running Latency Buckets Tests...\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (error) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${error.message}`);
        failed++;
    }
}

// Tests
test('Empty bucket initialization', () => {
    const { getBuckets } = createLatencyBuckets();
    const buckets = getBuckets();
    assert.strictEqual(buckets['0-100'], 0);
    assert.strictEqual(buckets['100-500'], 0);
    assert.strictEqual(buckets['500ms-1s'], 0);
    assert.strictEqual(buckets['1-5s'], 0);
    assert.strictEqual(buckets['5-10s'], 0);
    assert.strictEqual(buckets['10s+'], 0);
});

test('Add latency to 0-100ms bucket', () => {
    const { addLatency, getBuckets } = createLatencyBuckets();
    addLatency(50);
    addLatency(99);
    const buckets = getBuckets();
    assert.strictEqual(buckets['0-100'], 2);
});

test('Add latency to 100-500ms bucket', () => {
    const { addLatency, getBuckets } = createLatencyBuckets();
    addLatency(100);
    addLatency(499);
    const buckets = getBuckets();
    assert.strictEqual(buckets['100-500'], 2);
});

test('Add latency to 500ms-1s bucket', () => {
    const { addLatency, getBuckets } = createLatencyBuckets();
    addLatency(500);
    addLatency(999);
    const buckets = getBuckets();
    assert.strictEqual(buckets['500ms-1s'], 2);
});

test('Add latency to 1-5s bucket', () => {
    const { addLatency, getBuckets } = createLatencyBuckets();
    addLatency(1000);
    addLatency(4999);
    const buckets = getBuckets();
    assert.strictEqual(buckets['1-5s'], 2);
});

test('Add latency to 5-10s bucket', () => {
    const { addLatency, getBuckets } = createLatencyBuckets();
    addLatency(5000);
    addLatency(9999);
    const buckets = getBuckets();
    assert.strictEqual(buckets['5-10s'], 2);
});

test('Add latency to 10s+ bucket', () => {
    const { addLatency, getBuckets } = createLatencyBuckets();
    addLatency(10000);
    addLatency(60000);
    const buckets = getBuckets();
    assert.strictEqual(buckets['10s+'], 2);
});

test('Calculate percentiles on empty array', () => {
    const { getSummary } = createLatencyBuckets();
    const summary = getSummary([]);
    assert.strictEqual(summary.mean, 0);
    assert.strictEqual(summary.p50, 0);
    assert.strictEqual(summary.p95, 0);
    assert.strictEqual(summary.p99, 0);
});

test('Calculate mean correctly', () => {
    const { getSummary } = createLatencyBuckets();
    const summary = getSummary([100, 200, 300, 400, 500]);
    assert.strictEqual(summary.mean, 300);
});

test('Calculate p50 correctly', () => {
    const { getSummary } = createLatencyBuckets();
    const summary = getSummary([10, 20, 30, 40, 50]);
    assert.strictEqual(summary.p50, 30);
});

test('Calculate p95 correctly', () => {
    const { getSummary } = createLatencyBuckets();
    // 100 values from 0-99, p95 should be ~95 (floor(100 * 0.95) = 95)
    const data = Array.from({ length: 100 }, (_, i) => i);
    const summary = getSummary(data);
    assert.strictEqual(summary.p95, 95);
});

test('Calculate p99 correctly', () => {
    const { getSummary } = createLatencyBuckets();
    // 100 values from 0-99, p99 should be 99 (floor(100 * 0.99) = 99)
    const data = Array.from({ length: 100 }, (_, i) => i);
    const summary = getSummary(data);
    assert.strictEqual(summary.p99, 99);
});

test('Boundary value: 99ms goes to 0-100 bucket', () => {
    const { addLatency, getBuckets } = createLatencyBuckets();
    addLatency(99);
    const buckets = getBuckets();
    assert.strictEqual(buckets['0-100'], 1);
    assert.strictEqual(buckets['100-500'], 0);
});

test('Boundary value: 100ms goes to 100-500 bucket', () => {
    const { addLatency, getBuckets } = createLatencyBuckets();
    addLatency(100);
    const buckets = getBuckets();
    assert.strictEqual(buckets['0-100'], 0);
    assert.strictEqual(buckets['100-500'], 1);
});

// Summary
console.log(`\n========================================`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
