/**
 * Metrics Collection Module
 *
 * Provides comprehensive observability metrics:
 * - Counters: messages_processed, pods_classified, emails_sent, errors_total
 * - Gauges: queue_depths, active_legal_holds, storage_usage
 * - Histograms: processing_time_ms, ocr_duration_ms, email_send_duration_ms
 *
 * Endpoints:
 * - GET /metrics - Prometheus format
 * - GET /api/metrics - JSON format
 */

const db = require('./db');
const fs = require('fs');
const path = require('path');

const STORAGE_BASE = process.env.STORAGE_BASE_PATH || '/data/whatsapp-pod-pods';
const WINDOW_SIZE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * In-memory metrics store with sliding window
 */
const metrics = {
    // Counters
    counters: {
        messages_processed: 0,
        pods_classified: 0,
        pods_routed_out: 0,
        emails_sent: 0,
        emails_failed: 0,
        errors_total: 0,
        exports_created: 0,
        evidence_bundles_created: 0,
        legal_holds_applied: 0,
        attachments_archived: 0,
        attachments_deleted: 0
    },

    // Gauges
    gauges: {
        queue_review_count: 0,
        queue_out_count: 0,
        queue_email_pending: 0,
        queue_retry_count: 0,
        active_legal_holds: 0,
        storage_used_bytes: 0,
        memory_heap_used_bytes: 0
    },

    // Histograms (buckets for percentiles)
    histograms: {
        processing_time_ms: { values: [], buckets: [100, 500, 1000, 5000, 10000] },
        ocr_duration_ms: { values: [], buckets: [500, 1000, 2000, 5000, 10000] },
        email_send_duration_ms: { values: [], buckets: [100, 500, 1000, 5000, 10000] },
        classification_confidence: { values: [], buckets: [0.5, 0.7, 0.8, 0.9, 0.95, 1.0] }
    },

    // Sliding window for time-series data
    timeSeries: {
        messages_per_minute: [],
        errors_per_minute: [],
        processing_times: []
    },

    // Last update timestamp
    lastUpdated: null
};

// Processing time tracking
const processingStartTimes = new Map();

/**
 * Initialize metrics module
 */
function init() {
    console.log('[Metrics] Module initialized');
    loadFromDatabase();
    startCleanupInterval();
}

/**
 * Load initial metrics from database
 */
function loadFromDatabase() {
    try {
        const database = db.getDb();

        // Load counters from DB
        const statusCounts = database.prepare(`
            SELECT status, COUNT(*) as count FROM attachments GROUP BY status
        `).all();

        statusCounts.forEach(row => {
            if (row.status === 'REVIEW') metrics.gauges.queue_review_count = row.count;
            else if (row.status === 'OUT') metrics.gauges.queue_out_count = row.count;
            else if (row.status === 'QUARANTINE') metrics.gauges.quarantine_count = row.count;
        });

        // Total processed
        metrics.counters.messages_processed = database.prepare(`
            SELECT COUNT(*) as count FROM attachments
        `).get().count;

        // Email queue
        const emailStats = database.prepare(`
            SELECT status, COUNT(*) as count FROM email_queue GROUP BY status
        `).all();
        emailStats.forEach(row => {
            if (row.status === 'PENDING') metrics.gauges.queue_email_pending = row.count;
            else if (row.status === 'RETRY') metrics.gauges.queue_retry_count = row.count;
        });

        // Legal holds
        const legalHolds = database.prepare(`
            SELECT COUNT(*) as count FROM legal_holds WHERE status = 'ACTIVE'
        `).get();
        metrics.gauges.active_legal_holds = legalHolds?.count || 0;
        metrics.counters.legal_holds_applied = metrics.gauges.active_legal_holds;

        metrics.lastUpdated = new Date().toISOString();
        console.log('[Metrics] Loaded from database');
    } catch (error) {
        console.error('[Metrics] Load error:', error.message);
    }
}

/**
 * Start cleanup interval for sliding window
 */
function startCleanupInterval() {
    setInterval(() => {
        cleanupTimeSeries();
        updateMemoryGauge();
    }, 60000); // Every minute
}

/**
 * Cleanup old time-series data
 */
function cleanupTimeSeries() {
    const cutoff = Date.now() - WINDOW_SIZE_MS;

    // Clean histograms
    Object.keys(metrics.histograms).forEach(key => {
        const hist = metrics.histograms[key];
        hist.values = hist.values.filter(v => v.timestamp > cutoff);
        // Keep max 1000 values per histogram
        if (hist.values.length > 1000) {
            hist.values = hist.values.slice(-1000);
        }
    });

    // Clean time series
    Object.keys(metrics.timeSeries).forEach(key => {
        metrics.timeSeries[key] = metrics.timeSeries[key].filter(v => v.timestamp > cutoff);
    });
}

/**
 * Update memory gauge
 */
function updateMemoryGauge() {
    const mem = process.memoryUsage();
    metrics.gauges.memory_heap_used_bytes = mem.heapUsed;
}

/**
 * Increment a counter
 */
function incrementCounter(name, value = 1) {
    if (metrics.counters[name] !== undefined) {
        metrics.counters[name] += value;
        metrics.lastUpdated = new Date().toISOString();
    }
}

/**
 * Decrement a counter
 */
function decrementCounter(name, value = 1) {
    if (metrics.counters[name] !== undefined) {
        metrics.counters[name] = Math.max(0, metrics.counters[name] - value);
        metrics.lastUpdated = new Date().toISOString();
    }
}

/**
 * Set a gauge value
 */
function setGauge(name, value) {
    if (metrics.gauges[name] !== undefined) {
        metrics.gauges[name] = value;
        metrics.lastUpdated = new Date().toISOString();
    }
}

/**
 * Start timing an operation
 */
function startTiming(operationId) {
    processingStartTimes.set(operationId, Date.now());
}

/**
 * End timing and record histogram
 */
function endTiming(operationId, histogramName) {
    const startTime = processingStartTimes.get(operationId);
    if (startTime) {
        const duration = Date.now() - startTime;
        recordHistogramValue(histogramName, duration);
        processingStartTimes.delete(operationId);
        return duration;
    }
    return null;
}

/**
 * Record a value to a histogram
 */
function recordHistogramValue(histogramName, value) {
    if (metrics.histograms[histogramName]) {
        metrics.histograms[histogramName].values.push({
            value,
            timestamp: Date.now()
        });
        metrics.lastUpdated = new Date().toISOString();
    }
}

/**
 * Record processing event
 */
function recordProcessing(type, data = {}) {
    metrics.counters.messages_processed++;

    if (type === 'pod_classified') {
        metrics.counters.pods_classified++;
    } else if (type === 'routed_out') {
        metrics.counters.pods_routed_out++;
    } else if (type === 'email_sent') {
        metrics.counters.emails_sent++;
    } else if (type === 'email_failed') {
        metrics.counters.emails_failed++;
        metrics.counters.errors_total++;
    } else if (type === 'error') {
        metrics.counters.errors_total++;
    }

    // Record to time series
    const now = Date.now();
    metrics.timeSeries.messages_per_minute.push({
        timestamp: now,
        type,
        count: 1
    });
}

/**
 * Update queue gauges from database
 */
function updateQueueGauges() {
    try {
        const database = db.getDb();

        const review = database.prepare(
            "SELECT COUNT(*) as count FROM attachments WHERE status = 'REVIEW'"
        ).get().count;

        const out = database.prepare(
            "SELECT COUNT(*) as count FROM attachments WHERE status = 'OUT'"
        ).get().count;

        const emailPending = database.prepare(
            "SELECT COUNT(*) as count FROM email_queue WHERE status = 'PENDING'"
        ).get().count;

        const retry = database.prepare(
            "SELECT COUNT(*) as count FROM email_queue WHERE status = 'RETRY'"
        ).get().count;

        setGauge('queue_review_count', review);
        setGauge('queue_out_count', out);
        setGauge('queue_email_pending', emailPending);
        setGauge('queue_retry_count', retry);
    } catch (error) {
        console.error('[Metrics] Queue update error:', error.message);
    }
}

/**
 * Calculate histogram statistics
 */
function calculateHistogramStats(histogramName) {
    const hist = metrics.histograms[histogramName];
    if (!hist || hist.values.length === 0) {
        return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p99: 0 };
    }

    const values = hist.values.map(v => v.value).sort((a, b) => a - b);
    const count = values.length;

    const getPercentile = (p) => {
        const idx = Math.floor(count * p);
        return values[Math.min(idx, count - 1)] || 0;
    };

    return {
        count,
        min: values[0],
        max: values[count - 1],
        mean: Math.round(values.reduce((a, b) => a + b, 0) / count),
        p50: getPercentile(0.50),
        p90: getPercentile(0.90),
        p95: getPercentile(0.95),
        p99: getPercentile(0.99)
    };
}

/**
 * Get metrics in Prometheus format
 */
function getMetricsPrometheus() {
    let output = '# WhatsApp POD Service Metrics\n';
    output += `# Generated: ${new Date().toISOString()}\n\n`;

    // Counters
    output += '# Counters\n';
    Object.keys(metrics.counters).forEach(name => {
        output += `whatsapp_${name} ${metrics.counters[name]}\n`;
    });

    // Gauges
    output += '\n# Gauges\n';
    Object.keys(metrics.gauges).forEach(name => {
        output += `whatsapp_${name} ${metrics.gauges[name]}\n`;
    });

    // Histogram summaries
    output += '\n# Histograms\n';
    Object.keys(metrics.histograms).forEach(name => {
        const stats = calculateHistogramStats(name);
        output += `whatsapp_${name}_count ${stats.count}\n`;
        output += `whatsapp_${name}_min ${stats.min}\n`;
        output += `whatsapp_${name}_max ${stats.max}\n`;
        output += `whatsapp_${name}_mean ${stats.mean}\n`;
        output += `whatsapp_${name}_p50 ${stats.p50}\n`;
        output += `whatsapp_${name}_p90 ${stats.p90}\n`;
        output += `whatsapp_${name}_p99 ${stats.p99}\n`;
    });

    // Process metrics
    const mem = process.memoryUsage();
    output += '\n# Process Metrics\n';
    output += `process_cpu_percent ${getCpuPercent()}\n`;
    output += `process_memory_heap_bytes ${mem.heapUsed}\n`;
    output += `process_memory_rss_bytes ${mem.rss}\n`;
    output += `process_uptime_seconds ${Math.floor(process.uptime())}\n`;

    return output;
}

/**
 * Get CPU usage percent (simplified)
 */
function getCpuPercent() {
    // Simplified - in production use os.cpuUsage()
    return 0;
}

/**
 * Get metrics in JSON format for dashboard
 */
function getMetricsJSON() {
    updateQueueGauges();

    return {
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        version: '1.0.0',
        counters: { ...metrics.counters },
        gauges: { ...metrics.gauges },
        histograms: Object.keys(metrics.histograms).reduce((acc, key) => {
            acc[key] = calculateHistogramStats(key);
            return acc;
        }, {}),
        timeSeries: {
            messagesLast24h: calculateMessagesLast24h(),
            errorsLast24h: calculateErrorsLast24h()
        }
    };
}

/**
 * Get dashboard summary (simplified for UI)
 */
function getDashboardSummary() {
    updateQueueGauges();

    try {
        const database = db.getDb();

        // Get counts by status
        const statusStats = database.prepare(`
            SELECT status, COUNT(*) as count FROM attachments GROUP BY status
        `).all();

        // Get today's stats
        const today = new Date().toISOString().split('T')[0];
        const todayStats = database.prepare(`
            SELECT COUNT(*) as count FROM attachments WHERE created_at LIKE ?
        `).get(`${today}%`);

        // Get this week's stats
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const weekStats = database.prepare(`
            SELECT COUNT(*) as count FROM attachments WHERE created_at > ?
        `).get(weekAgo.toISOString());

        // Calculate success rate
        const approved = statusStats.find(s => s.status === 'OUT')?.count || 0;
        const rejected = statusStats.find(s => s.status === 'QUARANTINE')?.count || 0;
        const totalProcessed = approved + rejected;
        const successRate = totalProcessed > 0
            ? Math.round((approved / totalProcessed) * 100)
            : 100;

        return {
            summary: {
                total: database.prepare(`SELECT COUNT(*) as count FROM attachments`).get().count,
                today: todayStats.count,
                thisWeek: weekStats.count,
                reviewQueue: metrics.gauges.queue_review_count,
                pendingEmails: metrics.gauges.queue_email_pending,
                processed: metrics.counters.messages_processed,
                approved: approved,
                rejected: rejected,
                successRate: successRate
            },
            statusBreakdown: statusStats.reduce((acc, row) => {
                acc[row.status] = row.count;
                return acc;
            }, {}),
            uptime: Math.floor(process.uptime()),
            lastUpdated: new Date().toISOString()
        };
    } catch (error) {
        console.error('[Metrics] getDashboardSummary error:', error.message);
        return { error: error.message, summary: {} };
    }
}

/**
 * Get processing metrics
 */
function getProcessingMetrics() {
    try {
        const database = db.getDb();

        const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const recentCount = database.prepare(`
            SELECT COUNT(*) as count FROM attachments WHERE created_at > ?
        `).get(last24h).count;

        const histStats = calculateHistogramStats('processing_time_ms');

        return {
            last24Hours: recentCount,
            averageProcessingTime: histStats.mean || 'N/A',
            throughput: recentCount,
            errorRate: metrics.counters.errors_total,
            processingTimeHist: histStats
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Get queue metrics
 */
function getQueueMetrics() {
    updateQueueGauges();

    return {
        review: metrics.gauges.queue_review_count,
        out: metrics.gauges.queue_out_count,
        emailQueue: metrics.gauges.queue_email_pending,
        retryQueue: metrics.gauges.queue_retry_count
    };
}

/**
 * Calculate messages in last 24 hours
 */
function calculateMessagesLast24h() {
    const cutoff = Date.now() - WINDOW_SIZE_MS;
    const messages = metrics.timeSeries.messages_per_minute.filter(m => m.timestamp > cutoff);
    return messages.reduce((sum, m) => sum + m.count, 0);
}

/**
 * Calculate errors in last 24 hours
 */
function calculateErrorsLast24h() {
    const cutoff = Date.now() - WINDOW_SIZE_MS;
    const errors = metrics.timeSeries.errors_per_minute.filter(e => e.timestamp > cutoff);
    return errors.reduce((sum, e) => sum + e.count, 0);
}

/**
 * Get all metrics as object
 */
function getAll() {
    return {
        counters: { ...metrics.counters },
        gauges: { ...metrics.gauges },
        histograms: Object.keys(metrics.histograms).reduce((acc, key) => {
            acc[key] = calculateHistogramStats(key);
            return acc;
        }, {}),
        lastUpdated: metrics.lastUpdated
    };
}

module.exports = {
    init,
    incrementCounter,
    decrementCounter,
    setGauge,
    startTiming,
    endTiming,
    recordHistogramValue,
    recordProcessing,
    updateQueueGauges,
    getMetricsPrometheus,
    getMetricsJSON,
    getDashboardSummary,
    getProcessingMetrics,
    getQueueMetrics,
    calculateHistogramStats,
    getAll
};
