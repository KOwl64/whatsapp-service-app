const db = require('./db');
let metricsStore = {
    processed: 0,
    failed: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    dailyStats: {}
};

function init() {
    console.log('[Metrics] Module initialized');
    // Load initial stats from DB
    try {
        const database = db.getDb();

        // Count by status
        const statusCounts = database.prepare(`
            SELECT status, COUNT(*) as count FROM attachments GROUP BY status
        `).all();

        statusCounts.forEach(row => {
            if (row.status === 'APPROVED') metricsStore.approved = row.count;
            else if (row.status === 'REJECTED') metricsStore.rejected = row.count;
            else if (row.status === 'REVIEW') metricsStore.pending = row.count;
            else if (row.status === 'SENT') metricsStore.processed = row.count;
        });

        // Total processed
        metricsStore.processed = database.prepare(`
            SELECT COUNT(*) as count FROM attachments WHERE status IN ('APPROVED', 'REJECTED', 'SENT')
        `).get().count;

    } catch (e) {
        console.error('[Metrics] Init error:', e.message);
    }
}

function record(type, data = {}) {
    if (type === 'processed') metricsStore.processed++;
    else if (type === 'failed') metricsStore.failed++;
    else if (type === 'approved') metricsStore.approved++;
    else if (type === 'rejected') metricsStore.rejected++;
    else if (type === 'pending') metricsStore.pending++;
}

function getDashboardSummary() {
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

        // Get queue counts
        const reviewCount = database.prepare(`
            SELECT COUNT(*) as count FROM attachments WHERE status = 'REVIEW'
        `).get().count;

        const pendingEmailCount = database.prepare(`
            SELECT COUNT(*) as count FROM email_queue WHERE status = 'PENDING'
        `).get().count;

        // Calculate success rate
        const totalProcessed = metricsStore.approved + metricsStore.rejected;
        const successRate = totalProcessed > 0
            ? Math.round((metricsStore.approved / totalProcessed) * 100)
            : 0;

        return {
            summary: {
                total: database.prepare(`SELECT COUNT(*) as count FROM attachments`).get().count,
                today: todayStats.count,
                thisWeek: weekStats.count,
                reviewQueue: reviewCount,
                pendingEmails: pendingEmailCount,
                processed: metricsStore.processed,
                approved: metricsStore.approved,
                rejected: metricsStore.rejected,
                successRate: successRate
            },
            statusBreakdown: statusStats.reduce((acc, row) => {
                acc[row.status] = row.count;
                return acc;
            }, {}),
            uptime: process.uptime(),
            lastUpdated: new Date().toISOString()
        };
    } catch (error) {
        console.error('[Metrics] getDashboardSummary error:', error.message);
        return { error: error.message, summary: {} };
    }
}

function getProcessingMetrics() {
    try {
        const database = db.getDb();

        // Get processing times (simplified)
        const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const recentCount = database.prepare(`
            SELECT COUNT(*) as count FROM attachments WHERE created_at > ?
        `).get(last24h).count;

        return {
            last24Hours: recentCount,
            averageProcessingTime: 'N/A', // Would need timestamp tracking
            throughput: recentCount,
            errorRate: metricsStore.failed > 0 ? metricsStore.failed : 0
        };
    } catch (error) {
        return { error: error.message };
    }
}

function getQueueMetrics() {
    try {
        const database = db.getDb();

        return {
            review: database.prepare(`SELECT COUNT(*) as count FROM attachments WHERE status = 'REVIEW'`).get().count,
            pending: database.prepare(`SELECT COUNT(*) as count FROM attachments WHERE status = 'PENDING'`).get().count,
            emailQueue: database.prepare(`SELECT COUNT(*) as count FROM email_queue WHERE status = 'PENDING'`).get().count,
            retryQueue: database.prepare(`SELECT COUNT(*) as count FROM email_queue WHERE status = 'RETRY'`).get().count
        };
    } catch (error) {
        return { error: error.message };
    }
}

module.exports = { init, record, getDashboardSummary, getProcessingMetrics, getQueueMetrics };
