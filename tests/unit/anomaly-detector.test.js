/**
 * Unit Tests: Anomaly Detection
 */

const assert = require('assert');

// Simplified anomaly detection functions for testing
function calculateMean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calculateStdDev(arr, meanVal) {
    if (arr.length === 0) return 0;
    const squareDiffs = arr.map(value => Math.pow(value - meanVal, 2));
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / arr.length);
}

function detectAnomaly(currentValue, historicalValues, sigmaThreshold = 3) {
    if (historicalValues.length < 2) return { detected: false, sigma: 0 };

    const mean = calculateMean(historicalValues);
    const stdDev = calculateStdDev(historicalValues, mean);

    if (stdDev === 0) {
        return { detected: false, sigma: 0, mean, stdDev };
    }

    const sigma = (currentValue - mean) / stdDev;
    return {
        detected: Math.abs(sigma) > sigmaThreshold,
        sigma: parseFloat(sigma.toFixed(2)),
        mean: parseFloat(mean.toFixed(2)),
        stdDev: parseFloat(stdDev.toFixed(2))
    };
}

function detectMemoryLeak(memorySnapshots) {
    if (memorySnapshots.length < 3) return { detected: false, reason: 'insufficient_data' };

    const sorted = memorySnapshots.sort((a, b) => a.timestamp - b.timestamp);
    const recent = sorted.slice(-5); // Last 5 snapshots

    // Check for monotonic increase
    let increasing = true;
    for (let i = 1; i < recent.length; i++) {
        if (recent[i].heapUsed <= recent[i-1].heapUsed) {
            increasing = false;
            break;
        }
    }

    if (increasing) {
        const growth = recent[recent.length - 1].heapUsed - recent[0].heapUsed;
        const growthRate = growth / recent.length; // per snapshot
        return {
            detected: growth > 10 * 1024 * 1024, // 10MB threshold
            reason: 'monotonic_increase',
            growthBytes: growth
        };
    }

    return { detected: false, reason: 'no_leak_detected' };
}

function calculateHealthScore(metrics) {
    const { errorRate = 0, latencyP95 = 0, memoryUsed = 0, memoryLimit = 1024 * 1024 * 1024 } = metrics;

    let score = 100;

    // -20% per 5% error rate
    score -= (errorRate * 100 / 5) * 20;

    // -1% per second of p95 latency
    score -= latencyP95 / 1000;

    // -10% at full memory
    score -= (memoryUsed / memoryLimit) * 10;

    return Math.max(0, Math.min(100, Math.round(score)));
}

// Test Suite
console.log('Running Anomaly Detector Tests...\n');

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

// Mean/StdDev Tests
test('calculateMean returns 0 for empty array', () => {
    assert.strictEqual(calculateMean([]), 0);
});

test('calculateMean calculates correctly', () => {
    assert.strictEqual(calculateMean([10, 20, 30, 40, 50]), 30);
});

test('calculateMean handles decimals', () => {
    assert.strictEqual(calculateMean([1.5, 2.5, 3.5]), 2.5);
});

test('calculateStdDev returns 0 for empty array', () => {
    assert.strictEqual(calculateStdDev([], 0), 0);
});

test('calculateStdDev calculates correctly', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] - stdDev = 2
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const mean = calculateMean(values);
    const stdDev = calculateStdDev(values, mean);
    assert.strictEqual(stdDev, 2);
});

// Anomaly Detection Tests
test('detectAnomaly returns false for empty history', () => {
    const result = detectAnomaly(100, []);
    assert.strictEqual(result.detected, false);
});

test('detectAnomaly returns false for single history value', () => {
    const result = detectAnomaly(100, [100]);
    assert.strictEqual(result.detected, false);
});

test('detectAnomaly detects spike above threshold', () => {
    // Normal values around 100, new value is 300 (3+ sigma)
    const result = detectAnomaly(300, [100, 102, 98, 101, 99], 2);
    assert.strictEqual(result.detected, true);
    assert.ok(result.sigma > 2);
});

test('detectAnomaly does not flag normal variance', () => {
    // Values vary by 2, new value is within normal range (sigma < 3)
    const result = detectAnomaly(104, [100, 102, 98, 101, 99], 3);
    assert.strictEqual(result.detected, false);
});

test('detectAnomaly detects low spike', () => {
    // Normal values around 100, new value is 10 (very low)
    const result = detectAnomaly(10, [100, 102, 98, 101, 99], 3);
    assert.strictEqual(result.detected, true);
});

// Memory Leak Detection Tests
test('detectMemoryLeak returns insufficient_data for <3 snapshots', () => {
    const result = detectMemoryLeak([
        { timestamp: 1, heapUsed: 100 },
        { timestamp: 2, heapUsed: 110 }
    ]);
    assert.strictEqual(result.detected, false);
    assert.strictEqual(result.reason, 'insufficient_data');
});

test('detectMemoryLeak detects monotonic increase', () => {
    const snapshots = [
        { timestamp: 1, heapUsed: 100 * 1024 * 1024 },
        { timestamp: 2, heapUsed: 110 * 1024 * 1024 },
        { timestamp: 3, heapUsed: 120 * 1024 * 1024 },
        { timestamp: 4, heapUsed: 130 * 1024 * 1024 },
        { timestamp: 5, heapUsed: 140 * 1024 * 1024 }
    ];
    const result = detectMemoryLeak(snapshots);
    assert.strictEqual(result.detected, true);
    assert.strictEqual(result.reason, 'monotonic_increase');
    assert.ok(result.growthBytes > 0);
});

test('detectMemoryLeak does not flag decreasing memory', () => {
    const snapshots = [
        { timestamp: 1, heapUsed: 140 * 1024 * 1024 },
        { timestamp: 2, heapUsed: 130 * 1024 * 1024 },
        { timestamp: 3, heapUsed: 120 * 1024 * 1024 },
        { timestamp: 4, heapUsed: 110 * 1024 * 1024 },
        { timestamp: 5, heapUsed: 100 * 1024 * 1024 }
    ];
    const result = detectMemoryLeak(snapshots);
    assert.strictEqual(result.detected, false);
    assert.strictEqual(result.reason, 'no_leak_detected');
});

// Health Score Tests
test('calculateHealthScore returns 100 for perfect metrics', () => {
    const score = calculateHealthScore({
        errorRate: 0,
        latencyP95: 0,
        memoryUsed: 0
    });
    assert.strictEqual(score, 100);
});

test('calculateHealthScore penalizes high error rate', () => {
    const score = calculateHealthScore({
        errorRate: 0.05, // 5%
        latencyP95: 0,
        memoryUsed: 0
    });
    assert.strictEqual(score, 80); // 100 - 20
});

test('calculateHealthScore penalizes high latency', () => {
    const score = calculateHealthScore({
        errorRate: 0,
        latencyP95: 1000, // 1 second
        memoryUsed: 0
    });
    assert.strictEqual(score, 99); // 100 - 1
});

test('calculateHealthScore penalizes high memory usage', () => {
    const score = calculateHealthScore({
        errorRate: 0,
        latencyP95: 0,
        memoryUsed: 0.5 * 1024 * 1024 * 1024, // 50%
        memoryLimit: 1024 * 1024 * 1024
    });
    assert.strictEqual(score, 95); // 100 - 5
});

test('calculateHealthScore floors at 0', () => {
    const score = calculateHealthScore({
        errorRate: 1.0, // 100% errors
        latencyP95: 50000, // 50 seconds
        memoryUsed: 1024 * 1024 * 1024 // 100%
    });
    assert.strictEqual(score, 0);
});

test('calculateHealthScore caps at 100', () => {
    const score = calculateHealthScore({
        errorRate: -0.1, // Negative error rate (shouldn't happen but test)
        latencyP95: -1000,
        memoryUsed: -100
    });
    assert.strictEqual(score, 100);
});

// Summary
console.log(`\n========================================`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
