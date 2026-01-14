const db = require('./db');
const { v4: uuidv4 } = require('uuid');

// In-memory alert store
let activeAlerts = [];
let alertHistory = [];
let alertRules = [
    { id: 'high_queue', name: 'High Review Queue', condition: 'queue > 50', severity: 'warning', enabled: true },
    { id: 'email_failed', name: 'Email Sending Failed', condition: 'email_error', severity: 'error', enabled: true },
    { id: 'storage_low', name: 'Storage Low', condition: 'storage < 10%', severity: 'critical', enabled: false }
];

function init() {
    console.log('[Alerts] Module initialized');
    // Load any persisted alerts from DB in a real implementation
}

function send(type, message, details = {}) {
    const alert = {
        id: uuidv4(),
        type,
        message,
        details,
        severity: type === 'error' ? 'critical' : type === 'warning' ? 'warning' : 'info',
        timestamp: new Date().toISOString(),
        acknowledged: false,
        acknowledgedBy: null,
        acknowledgedAt: null
    };

    activeAlerts.push(alert);
    alertHistory.push(alert);

    // Keep only last 1000 alerts in memory
    if (alertHistory.length > 1000) {
        alertHistory = alertHistory.slice(-1000);
    }

    console.log(`[Alerts] ${alert.severity.toUpperCase()}: ${message}`);
    return alert;
}

function getActiveAlerts() {
    return {
        alerts: activeAlerts.filter(a => !a.acknowledged),
        count: activeAlerts.filter(a => !a.acknowledged).length,
        acknowledged: activeAlerts.filter(a => a.acknowledged).slice(-10)
    };
}

function getHistory({ level = null, limit = 100 } = {}) {
    let history = alertHistory;

    if (level) {
        history = history.filter(a => a.severity === level);
    }

    return history.slice(-limit).reverse();
}

function getRules() {
    return alertRules;
}

function getStats() {
    return {
        total: alertHistory.length,
        critical: alertHistory.filter(a => a.severity === 'critical').length,
        warning: alertHistory.filter(a => a.severity === 'warning').length,
        info: alertHistory.filter(a => a.severity === 'info').length,
        unacknowledged: activeAlerts.filter(a => !a.acknowledged).length
    };
}

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

function clearAlert(id) {
    // Move to acknowledged if not already
    const alert = activeAlerts.find(a => a.id === id);
    if (alert) {
        alert.acknowledged = true;
        alert.acknowledgedBy = 'cleared';
        alert.acknowledgedAt = new Date().toISOString();
        return true;
    }
    return false;
}

function checkRules() {
    // In a full implementation, this would check conditions
    // For now, just emit alerts for testing
    return Promise.resolve([]);
}

module.exports = {
    init,
    send,
    getActiveAlerts,
    getHistory,
    getRules,
    getStats,
    acknowledgeAlert,
    clearAlert,
    checkRules
};
