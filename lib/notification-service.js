/**
 * Notification Service
 *
 * Centralized notification delivery for alerts and system events.
 * Supports multiple channels: Telegram, email, Slack, webhook.
 */

// Configuration - load from environment or use defaults
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8421475500:AAG_x_Xj8yb8hi920ap-KmiZTsbzb9HLI4';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1534241063';
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

// Notification channels
const CHANNELS = {
    telegram: true,
    webhook: !!WEBHOOK_URL,
    log: true
};

/**
 * Send Telegram notification
 * @param {string} message - Alert message
 * @param {string} severity - 'info', 'warning', 'critical'
 */
async function sendTelegram(message, severity = 'info') {
    const emoji = {
        info: 'ℹ️',
        warning: '⚠️',
        critical: '🚨'
    }[severity] || '📢';

    const fullMessage = `${emoji} ${message}`;

    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: fullMessage,
                parse_mode: 'Markdown'
            })
        });

        if (!response.ok) {
            console.error(`[Notification] Telegram failed: ${response.statusText}`);
            return false;
        }
        return true;
    } catch (error) {
        console.error(`[Notification] Telegram error:`, error.message);
        return false;
    }
}

/**
 * Send webhook notification
 * @param {Object} payload - Alert payload
 */
async function sendWebhook(payload) {
    if (!WEBHOOK_URL) return false;

    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...payload,
                timestamp: new Date().toISOString()
            })
        });
        return response.ok;
    } catch (error) {
        console.error(`[Notification] Webhook error:`, error.message);
        return false;
    }
}

/**
 * Log notification internally
 * @param {string} message - Message to log
 * @param {string} severity - Severity level
 */
function logNotification(message, severity) {
    const prefix = {
        info: '[Notification]',
        warning: '[Notification ⚠️]',
        critical: '[Notification 🚨]'
    }[severity] || '[Notification]';
    console.log(`${prefix} ${message}`);
}

/**
 * Send notification to all enabled channels
 * @param {string} message - Alert message
 * @param {Object} options - Notification options
 */
async function notify(message, options = {}) {
    const { severity = 'info', category = 'alert', data = {} } = options;

    const results = {};

    if (CHANNELS.telegram) {
        results.telegram = await sendTelegram(message, severity);
    }

    if (CHANNELS.webhook) {
        results.webhook = await sendWebhook({ message, severity, category, ...data });
    }

    if (CHANNELS.log) {
        logNotification(message, severity);
    }

    return results;
}

/**
 * Convenience methods for common notifications
 */
const notifications = {
    // Performance alerts
    highMemory: (used, limit) => notify(
        `High memory usage: ${used}MB / ${limit}MB`,
        { severity: 'warning', category: 'performance' }
    ),
    criticalMemory: (used, limit) => notify(
        `Critical memory usage: ${used}MB / ${limit}MB`,
        { severity: 'critical', category: 'performance' }
    ),
    highLatency: (p95, threshold) => notify(
        `High latency detected: p95=${p95}ms (threshold=${threshold}ms)`,
        { severity: 'warning', category: 'performance' }
    ),
    errorSpike: (rate, threshold) => notify(
        `Error rate spike: ${rate}% (threshold=${threshold}%)`,
        { severity: 'critical', category: 'performance' }
    ),

    // System alerts
    whatsappDisconnected: () => notify(
        'WhatsApp client disconnected',
        { severity: 'critical', category: 'system' }
    ),
    whatsappReconnected: () => notify(
        'WhatsApp client reconnected',
        { severity: 'info', category: 'system' }
    ),

    // Queue alerts
    queueBacklog: (count, threshold) => notify(
        `Email queue backlog: ${count} messages (threshold=${threshold})`,
        { severity: 'warning', category: 'queue' }
    ),

    // Phase/task notifications
    phaseComplete: (phase, task) => notify(
        `✅ Phase ${phase} complete: ${task}`,
        { severity: 'info', category: 'phase' }
    ),
    taskComplete: (phase, task) => notify(
        `✅ Task ${phase}.${task} completed`,
        { severity: 'info', category: 'task' }
    ),

    // Generic
    info: (msg) => notify(msg, { severity: 'info' }),
    warning: (msg) => notify(msg, { severity: 'warning' }),
    critical: (msg) => notify(msg, { severity: 'critical' })
};

/**
 * Initialize notification service
 * @param {Object} config - Configuration options
 */
function init(config = {}) {
    if (config.telegramToken) TELEGRAM_TOKEN = config.telegramToken;
    if (config.telegramChatId) TELEGRAM_CHAT_ID = config.telegramChatId;
    if (config.webhookUrl) process.env.ALERT_WEBHOOK_URL = config.webhookUrl;

    console.log('[Notification] Service initialized');
    return notifications;
}

module.exports = {
    notify,
    notifications,
    init,
    sendTelegram, // Exposed for direct calls
    sendWebhook
};
