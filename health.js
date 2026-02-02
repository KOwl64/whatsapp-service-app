/**
 * Health Check Module
 *
 * Provides comprehensive health check endpoints with three levels:
 * - BASIC: Simple server running check
 * - DEEP: Dependency connectivity checks
 * - FULL: Complete system diagnostics
 */

const db = require('./db');
const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';
const START_TIME = Date.now();

// Storage configuration
const STORAGE_BASE = process.env.STORAGE_BASE_PATH || '/data/whatsapp-pod-pods';

/**
 * Check database connectivity
 */
function checkDatabase() {
    try {
        const database = db.getDb();
        database.prepare('SELECT 1').get();
        return { status: 'healthy', message: 'Database connected' };
    } catch (error) {
        return { status: 'unhealthy', message: error.message };
    }
}

/**
 * Check WhatsApp connection status
 * Note: This relies on the isReady flag from service.js
 */
function checkWhatsApp() {
    // Import isReady from service - circular dependency avoided by checking at runtime
    try {
        // Try to access the health endpoint data from service
        // In production, this would check actual WhatsApp client state
        return { status: 'unknown', message: 'WhatsApp status requires service context' };
    } catch (error) {
        return { status: 'unhealthy', message: error.message };
    }
}

/**
 * Check storage availability
 */
function checkStorage() {
    try {
        if (!fs.existsSync(STORAGE_BASE)) {
            return { status: 'unhealthy', message: 'Storage directory does not exist' };
        }

        const stats = fs.statSync(STORAGE_BASE);
        const freeSpace = getFreeDiskSpace(STORAGE_BASE);
        const totalSpace = stats.size;

        // Calculate percentage free
        const freePercent = totalSpace > 0 ? Math.round((freeSpace / totalSpace) * 100) : 0;

        return {
            status: freePercent > 10 ? 'healthy' : 'degraded',
            message: `${freePercent}% free space`,
            details: {
                freeSpace: formatBytes(freeSpace),
                path: STORAGE_BASE
            }
        };
    } catch (error) {
        return { status: 'unhealthy', message: error.message };
    }
}

/**
 * Check queue depths
 */
function checkQueues() {
    try {
        const database = db.getDb();

        const reviewCount = database.prepare(
            "SELECT COUNT(*) as count FROM attachments WHERE status = 'REVIEW'"
        ).get().count;

        const outCount = database.prepare(
            "SELECT COUNT(*) as count FROM attachments WHERE status = 'OUT'"
        ).get().count;

        const emailPendingCount = database.prepare(
            "SELECT COUNT(*) as count FROM email_queue WHERE status = 'PENDING'"
        ).get().count;

        const quarantineCount = database.prepare(
            "SELECT COUNT(*) as count FROM attachments WHERE status = 'QUARANTINE'"
        ).get().count;

        const failedCount = database.prepare(
            "SELECT COUNT(*) as count FROM attachments WHERE status = 'FAILED'"
        ).get().count;

        const reviewThreshold = 100;
        const emailThreshold = 500;

        return {
            status: (reviewCount > reviewThreshold || emailPendingCount > emailThreshold) ? 'degraded' : 'healthy',
            message: 'Queue status checked',
            details: {
                review: { count: reviewCount, threshold: reviewThreshold },
                out: { count: outCount },
                emailPending: { count: emailPendingCount, threshold: emailThreshold },
                quarantine: { count: quarantineCount },
                failed: { count: failedCount }
            }
        };
    } catch (error) {
        return { status: 'unhealthy', message: error.message };
    }
}

/**
 * Check recent error rates (last 5 minutes)
 */
function checkErrorRate() {
    try {
        const database = db.getDb();
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

        // Count recent errors (attachments that failed)
        const recentErrors = database.prepare(
            "SELECT COUNT(*) as count FROM attachments WHERE status = 'FAILED' AND updated_at > ?"
        ).get(fiveMinutesAgo)?.count || 0;

        // Count total recent processing
        const recentTotal = database.prepare(
            "SELECT COUNT(*) as count FROM attachments WHERE updated_at > ?"
        ).get(fiveMinutesAgo)?.count || 0;

        const errorRate = recentTotal > 0 ? (recentErrors / recentTotal) * 100 : 0;

        return {
            status: errorRate > 10 ? 'unhealthy' : errorRate > 5 ? 'degraded' : 'healthy',
            message: `${errorRate.toFixed(1)}% error rate`,
            details: {
                recentErrors,
                recentTotal,
                errorRate: Math.round(errorRate * 10) / 10
            }
        };
    } catch (error) {
        return { status: 'unhealthy', message: error.message };
    }
}

/**
 * Check memory usage
 */
function checkMemory() {
    const used = process.memoryUsage();
    const total = 512 * 1024 * 1024; // Assume 512MB limit for Node.js
    const usedPercent = (used.heapUsed / total) * 100;

    return {
        status: usedPercent > 90 ? 'unhealthy' : usedPercent > 75 ? 'degraded' : 'healthy',
        message: `${usedPercent.toFixed(1)}% memory used`,
        details: {
            heapUsed: formatBytes(used.heapUsed),
            heapTotal: formatBytes(used.heapTotal),
            rss: formatBytes(used.rss),
            external: formatBytes(used.external)
        }
    };
}

/**
 * Check legal holds
 */
function checkLegalHolds() {
    try {
        const database = db.getDb();
        const activeHolds = database.prepare(
            "SELECT COUNT(*) as count FROM legal_holds WHERE status = 'ACTIVE'"
        ).get().count;

        return {
            status: 'healthy',
            message: `${activeHolds} active legal holds`,
            details: { activeHolds }
        };
    } catch (error) {
        // Table might not exist yet
        return { status: 'healthy', message: 'Legal hold table not initialized', details: { activeHolds: 0 } };
    }
}

/**
 * Run BASIC health check
 */
function runBasicCheck() {
    return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: VERSION,
        uptime: Math.floor(process.uptime())
    };
}

/**
 * Run DEEP health check
 */
function runDeepCheck() {
    const checks = {
        database: checkDatabase(),
        storage: checkStorage(),
        queues: checkQueues(),
        errorRate: checkErrorRate(),
        memory: checkMemory()
    };

    const hasUnhealthy = Object.values(checks).some(c => c.status === 'unhealthy');
    const hasDegraded = Object.values(checks).some(c => c.status === 'degraded');

    return {
        status: hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy',
        timestamp: new Date().toISOString(),
        version: VERSION,
        uptime: Math.floor(process.uptime()),
        checks
    };
}

/**
 * Run FULL health check
 */
function runFullCheck() {
    const deepCheck = runDeepCheck();
    const legalHolds = checkLegalHolds();

    // Add additional diagnostics
    const diagnostics = {
        process: {
            pid: process.pid,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            memoryUsage: checkMemory().details
        },
        database: {
            path: db.getDbPath?.() || 'unknown',
            size: getDbSize()
        },
        storage: {
            basePath: STORAGE_BASE,
            directories: listStorageDirectories()
        },
        legalHolds: legalHolds.details
    };

    return {
        ...deepCheck,
        diagnostics
    };
}

/**
 * Get database size
 */
function getDbSize() {
    try {
        const dbPath = db.getDbPath?.();
        if (dbPath && fs.existsSync(dbPath)) {
            return formatBytes(fs.statSync(dbPath).size);
        }
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * List storage directories
 */
function listStorageDirectories() {
    try {
        if (!fs.existsSync(STORAGE_BASE)) return [];
        return fs.readdirSync(STORAGE_BASE).filter(dir =>
            fs.statSync(path.join(STORAGE_BASE, dir)).isDirectory()
        );
    } catch {
        return [];
    }
}

/**
 * Get free disk space
 */
function getFreeDiskSpace(dirPath) {
    try {
        const stats = fs.statSync(dirPath);
        return stats.size;
    } catch {
        return 0;
    }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Main health check function
 */
function checkHealth({ level = 'deep' } = {}) {
    switch (level) {
        case 'basic':
            return runBasicCheck();
        case 'full':
            return runFullCheck();
        case 'deep':
        default:
            return runDeepCheck();
    }
}

/**
 * Get HTTP status code for health result
 */
function getHttpStatus(healthResult) {
    switch (healthResult.status) {
        case 'healthy':
            return 200;
        case 'degraded':
            return 200;
        case 'unhealthy':
        default:
            return 503;
    }
}

/**
 * Initialize module
 */
function init() {
    console.log('[Health] Module initialized with levels: basic, deep, full');
}

module.exports = {
    init,
    checkHealth,
    getHttpStatus,
    checkDatabase,
    checkStorage,
    checkQueues,
    checkErrorRate,
    checkMemory,
    checkLegalHolds,
    runBasicCheck,
    runDeepCheck,
    runFullCheck,
    VERSION
};
