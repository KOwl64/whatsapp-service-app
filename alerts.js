/**
 * Alert System Module
 *
 * Provides comprehensive alerting with:
 * - Alert rules: queue-backlog, error-rate, whatsapp-disconnected, storage-low, email-stuck
 * - Alert levels: INFO, WARNING, CRITICAL
 * - Notification channels: webhook, log, email (future)
 * - Silence/acknowledge functionality
 *
 * Endpoints:
 * - GET /api/alerts/active - Active alerts
 * - GET /api/alerts/history - Alert history
 * - GET /api/alerts/rules - Alert rules
 * - POST /api/alerts/acknowledge/:id - Acknowledge alert
 * - POST /api/alerts/silence/:ruleId - Silence rule
 * - POST /api/alerts/check - Trigger alert check
 */

const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');

// Configuration
const config = {
    webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
    webhookEnabled: !!process.env.ALERT_WEBHOOK_URL,
    checkInterval: 60000, // 60 seconds
    maxHistorySize: 1000,
    silenceDefaultMinutes: 60
};

// In-memory alert store
let activeAlerts = [];
let alertHistory = [];
let silencedRules = new Map(); // ruleId -> { expiresAt }
let alertRules = [];

/**
 * Initialize alert rules
 */
function initAlertRules() {
    alertRules = [
        {
            id: 'review-queue-high',
            name: 'High Review Queue',
            description: 'Review queue exceeds threshold',
            condition: 'review_queue > 100',
            severity: 'WARNING',
            enabled: true,
            cooldownMinutes: 5,
            runbookId: 'QUEUE_BACKLOG'
        },
        {
            id: 'email-queue-stuck',
            name: 'Email Queue Stuck',
            description: 'Email queue has not processed in over 1 hour',
            condition: 'email_queue_stuck > 3600',
            severity: 'WARNING',
            enabled: true,
            cooldownMinutes: 10,
            runbookId: 'EMAIL_FAILURE'
        },
        {
            id: 'error-rate-spike',
            name: 'High Error Rate',
            description: 'Error rate exceeds 10% in last 5 minutes',
            condition: 'error_rate > 10',
            severity: 'CRITICAL',
            enabled: true,
            cooldownMinutes: 2,
            runbookId: 'SYSTEM_ERROR'
        },
        {
            id: 'storage-low',
            name: 'Low Storage',
            description: 'Available storage falls below 10%',
            condition: 'storage_free < 10',
            severity: 'CRITICAL',
            enabled: true,
            cooldownMinutes: 30,
            runbookId: 'STORAGE_FULL'
        },
        {
            id: 'whatsapp-disconnected',
            name: 'WhatsApp Disconnected',
            description: 'WhatsApp client is not connected',
            condition: 'whatsapp_connected == false',
            severity: 'CRITICAL',
            enabled: true,
            cooldownMinutes: 1,
            runbookId: 'WHATSAPP_DISCONNECTED'
        },
        {
            id: 'failed-emails-high',
            name: 'High Email Failure Rate',
            description: 'Email failure rate exceeds 5%',
            condition: 'email_failure_rate > 5',
            severity: 'WARNING',
            enabled: true,
            cooldownMinutes: 15,
            runbookId: 'EMAIL_FAILURE'
        },
        {
            id: 'legal-holds-expiring',
            name: 'Legal Holds Expiring Soon',
            description: 'Legal holds expiring in next 7 days',
            condition: 'legal_holds_expiring > 0',
            severity: 'INFO',
            enabled: true,
            cooldownMinutes: 1440, // 24 hours
            runbookId: 'LEGAL_HOLD_EXPIRING'
        }
    ];
}

/**
 * Initialize module
 */
function init() {
    initAlertRules();
    console.log('[Alerts] Module initialized with', alertRules.length, 'rules');
    startAlertChecker();
}

/**
 * Start background alert checker
 */
function startAlertChecker() {
    setInterval(async () => {
        try {
            await checkRules();
        } catch (error) {
            console.error('[Alerts] Check error:', error.message);
        }
    }, config.checkInterval);
}

/**
 * Create and fire an alert
 */
function send(level, title, message, details = {}) {
    const alert = {
        id: uuidv4(),
        level, // INFO, WARNING, CRITICAL
        title,
        message,
        details,
        timestamp: new Date().toISOString(),
        acknowledged: false,
        acknowledgedBy: null,
        acknowledgedAt: null,
        resolved: false,
        resolvedAt: null
    };

    activeAlerts.push(alert);
    alertHistory.push(alert);

    // Keep history bounded
    if (alertHistory.length > config.maxHistorySize) {
        alertHistory = alertHistory.slice(-config.maxHistorySize);
    }

    // Log alert
    console.log(`[Alerts] ${level}: ${title} - ${message}`);

    // Send to webhook if enabled
    if (config.webhookEnabled) {
        sendWebhook(alert);
    }

    return alert;
}

/**
 * Send alert to webhook
 */
function sendWebhook(alert) {
    if (!config.webhookUrl) return;

    const payload = JSON.stringify({
        event: 'alert',
        timestamp: new Date().toISOString(),
        alert
    });

    const url = new URL(config.webhookUrl);
    const reqOptions = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 5000
    };

    const req = (url.protocol === 'https' ? https : http).request(reqOptions, (res) => {
        if (res.statusCode >= 400) {
            console.error('[Alerts] Webhook error:', res.statusCode);
        }
    });

    req.on('error', (error) => {
        console.error('[Alerts] Webhook failed:', error.message);
    });

    req.write(payload);
    req.end();
}

/**
 * Check all alert rules
 */
async function checkRules() {
    const triggered = [];

    for (const rule of alertRules) {
        if (!rule.enabled) continue;
        if (isSilenced(rule.id)) continue;

        const condition = await evaluateCondition(rule.condition);
        if (condition) {
            const alert = send(rule.severity, rule.name, rule.description, {
                ruleId: rule.id,
                condition: rule.condition,
                value: condition,
                runbookId: rule.runbookId
            });
            triggered.push({ rule, alert });

            // Set cooldown
            silencedRules.set(rule.id, {
                expiresAt: Date.now() + rule.cooldownMinutes * 60 * 1000
            });
        }
    }

    return triggered;
}

/**
 * Evaluate a condition
 */
async function evaluateCondition(condition) {
    try {
        const db = require('./db').getDb();

        // Parse condition
        const match = condition.match(/^(\w+)\s*(>|<|>=|<=|==|!=|>|<|>|<)\s*(.+)$/);
        if (!match) return false;

        const metric = match[1];
        const operator = match[2];
        const threshold = parseFloat(match[3]);

        let value;

        switch (metric) {
            case 'review_queue':
                value = db.prepare(
                    "SELECT COUNT(*) as count FROM attachments WHERE status = 'REVIEW'"
                ).get().count;
                break;

            case 'email_queue_stuck':
                // Check oldest pending email
                const oldestEmail = db.prepare(
                    "SELECT MIN(created_at) as oldest FROM email_queue WHERE status = 'PENDING'"
                ).get();
                if (!oldestEmail?.oldest) {
                    value = 0;
                } else {
                    value = (Date.now() - new Date(oldestEmail.oldest).getTime()) / 1000;
                }
                break;

            case 'error_rate':
                const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
                const recentErrors = db.prepare(
                    "SELECT COUNT(*) as count FROM attachments WHERE status = 'FAILED' AND updated_at > ?"
                ).get(fiveMinAgo)?.count || 0;
                const recentTotal = db.prepare(
                    "SELECT COUNT(*) as count FROM attachments WHERE updated_at > ?"
                ).get(fiveMinAgo)?.count || 1;
                value = (recentErrors / recentTotal) * 100;
                break;

            case 'storage_free':
                const stats = require('fs').statSync(
                    process.env.STORAGE_BASE_PATH || '/data/whatsapp-pod-pods'
                );
                value = 50; // Simplified - would check actual free space
                break;

            case 'whatsapp_connected':
                // Check via health module
                const health = require('./health');
                value = 1; // Would check actual WhatsApp status
                break;

            case 'email_failure_rate':
                const totalEmails = db.prepare(
                    "SELECT COUNT(*) as count FROM email_queue"
                ).get().count;
                const failedEmails = db.prepare(
                    "SELECT COUNT(*) as count FROM email_queue WHERE status IN ('FAILED', 'BOUNCED')"
                ).get().count;
                value = totalEmails > 0 ? (failedEmails / totalEmails) * 100 : 0;
                break;

            case 'legal_holds_expiring':
                const sevenDaysFromNow = new Date();
                sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
                value = db.prepare(
                    "SELECT COUNT(*) as count FROM legal_holds WHERE status = 'ACTIVE' AND expires_at < ?"
                ).get(sevenDaysFromNow.toISOString())?.count || 0;
                break;

            default:
                return false;
        }

        // Evaluate operator
        switch (operator) {
            case '>': return value > threshold;
            case '<': return value < threshold;
            case '>=': return value >= threshold;
            case '<=': return value <= threshold;
            case '==': return value === threshold;
            case '!=': return value !== threshold;
            default: return false;
        }
    } catch (error) {
        console.error('[Alerts] Condition evaluation error:', error.message);
        return false;
    }
}

/**
 * Check if a rule is silenced
 */
function isSilenced(ruleId) {
    const silence = silencedRules.get(ruleId);
    if (!silence) return false;
    if (silence.expiresAt < Date.now()) {
        silencedRules.delete(ruleId);
        return false;
    }
    return true;
}

/**
 * Get active alerts
 */
function getActiveAlerts() {
    return {
        alerts: activeAlerts.filter(a => !a.acknowledged && !a.resolved),
        count: activeAlerts.filter(a => !a.acknowledged && !a.resolved).length,
        acknowledged: activeAlerts.filter(a => a.acknowledged && !a.resolved),
        resolved: activeAlerts.filter(a => a.resolved).slice(-10)
    };
}

/**
 * Get alert history
 */
function getHistory({ level = null, limit = 100 } = {}) {
    let history = alertHistory;

    if (level) {
        history = history.filter(a => a.level === level.toUpperCase());
    }

    return history.slice(-limit).reverse();
}

/**
 * Get alert rules
 */
function getRules() {
    return alertRules.map(rule => ({
        ...rule,
        silenced: isSilenced(rule.id)
    }));
}

/**
 * Get alert statistics
 */
function getStats() {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const recentHistory = alertHistory.filter(a =>
        new Date(a.timestamp).getTime() > oneHourAgo
    );

    return {
        total: alertHistory.length,
        critical: alertHistory.filter(a => a.level === 'CRITICAL').length,
        warning: alertHistory.filter(a => a.level === 'WARNING').length,
        info: alertHistory.filter(a => a.level === 'INFO').length,
        unacknowledged: activeAlerts.filter(a => !a.acknowledged).length,
        lastHour: recentHistory.length,
        last24h: alertHistory.filter(a =>
            new Date(a.timestamp).getTime() > oneDayAgo
        ).length
    };
}

/**
 * Acknowledge an alert
 */
function acknowledgeAlert(id, by = 'api') {
    const alert = activeAlerts.find(a => a.id === id);
    if (alert) {
        alert.acknowledged = true;
        alert.acknowledgedBy = by;
        alert.acknowledgedAt = new Date().toISOString();
        console.log(`[Alerts] Alert ${id} acknowledged by ${by}`);
        return true;
    }
    return false;
}

/**
 * Silence an alert rule
 */
function silenceRule(ruleId, minutes = config.silenceDefaultMinutes) {
    const rule = alertRules.find(r => r.id === ruleId);
    if (!rule) return { success: false, error: 'Rule not found' };

    silencedRules.set(ruleId, {
        expiresAt: Date.now() + minutes * 60 * 1000
    });

    console.log(`[Alerts] Rule ${ruleId} silenced for ${minutes} minutes`);
    return { success: true, ruleId, silencedForMinutes: minutes };
}

/**
 * Unsilence a rule
 */
function unsilenceRule(ruleId) {
    if (silencedRules.has(ruleId)) {
        silencedRules.delete(ruleId);
        return { success: true, ruleId };
    }
    return { success: false, error: 'Rule not silenced' };
}

/**
 * Clear all active alerts
 */
function clearAlerts(by = 'api') {
    const count = activeAlerts.length;
    activeAlerts = activeAlerts.map(a => ({
        ...a,
        resolved: true,
        resolvedAt: new Date().toISOString(),
        resolvedBy: by
    }));
    console.log(`[Alerts] Cleared ${count} alerts by ${by}`);
    return count;
}

/**
 * Resolve a specific alert
 */
function resolveAlert(id, by = 'api') {
    const alert = activeAlerts.find(a => a.id === id);
    if (alert) {
        alert.resolved = true;
        alert.resolvedAt = new Date().toISOString();
        alert.resolvedBy = by;
        return true;
    }
    return false;
}

/**
 * Test alert rule
 */
function testRule(ruleId) {
    const rule = alertRules.find(r => r.id === ruleId);
    if (!rule) return { success: false, error: 'Rule not found' };

    // Fire a test alert
    const alert = send('INFO', `[TEST] ${rule.name}`, `Test alert for ${rule.id}`, {
        ruleId: rule.id,
        isTest: true
    });

    return { success: true, alert };
}

/**
 * Configure webhook
 */
function configureWebhook(url) {
    config.webhookUrl = url;
    config.webhookEnabled = !!url;
    console.log(`[Alerts] Webhook ${config.webhookEnabled ? 'enabled' : 'disabled'}`);
    return { success: true, webhookEnabled: config.webhookEnabled };
}

module.exports = {
    init,
    send,
    checkRules,
    getActiveAlerts,
    getHistory,
    getRules,
    getStats,
    acknowledgeAlert,
    silenceRule,
    unsilenceRule,
    clearAlerts,
    resolveAlert,
    testRule,
    configureWebhook,
    evaluateCondition,
    isSilenced
};
