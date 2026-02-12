/**
 * Test Runner
 *
 * Runs all unit tests for the WhatsApp Service
 */

const { execSync } = require('child_process');
const path = require('path');

const testFiles = [
    'unit/latency-buckets.test.js',
    'unit/anomaly-detector.test.js'
];

console.log('='.repeat(50));
console.log('WhatsApp Service - Unit Tests');
console.log('='.repeat(50));
console.log();

let totalPassed = 0;
let totalFailed = 0;

for (const testFile of testFiles) {
    const testPath = path.join(__dirname, testFile);
    console.log(`\nRunning: ${testFile}`);
    console.log('-'.repeat(50));

    try {
        execSync(`node "${testPath}"`, { cwd: __dirname, stdio: 'pipe' });
        // Parse output for pass/fail count would go here
        totalPassed++;
    } catch (error) {
        console.error(`Failed: ${testFile}`);
        totalFailed++;
    }
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${totalPassed} passed, ${totalFailed} failed`);
console.log('='.repeat(50));

process.exit(totalFailed > 0 ? 1 : 0);
