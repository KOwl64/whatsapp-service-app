const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { logAudit, getAuditTrail, getAuditTrailByCorrelationId, generateUUID } = require('./models');

// Audit action types
const AUDIT_ACTIONS = {
    INGEST: 'INGEST',
    NORMALISE: 'NORMALISE',
    CLASSIFY: 'CLASSIFY',
    MATCH: 'MATCH',
    ROUTE: 'ROUTE',
    REVIEW: 'REVIEW',
    EXPORT: 'EXPORT',
    EXPORT_PREPARED: 'EXPORT_PREPARED',
    EXPORT_QUEUED: 'EXPORT_QUEUED',
    DELETE: 'DELETE',
    FAILED: 'FAILED',
    OCR_EXTRACTED: 'OCR_EXTRACTED',
    FIELDS_EXTRACTED: 'FIELDS_EXTRACTED',
    // Retention & Governance actions
    LEGAL_HOLD_CREATED: 'LEGAL_HOLD_CREATED',
    LEGAL_HOLD_RELEASED: 'LEGAL_HOLD_RELEASED',
    LEGAL_HOLD_EXPIRED: 'LEGAL_HOLD_EXPIRED',
    RETENTION_POLICY_APPLIED: 'RETENTION_POLICY_APPLIED',
    RETENTION_CLEANUP_RUN: 'RETENTION_CLEANUP_RUN',
    ARCHIVE_ARCHIVED: 'ARCHIVE_ARCHIVED',
    ARCHIVE_RESTORED: 'ARCHIVE_RESTORED',
    ARCHIVE_SOFT_DELETED: 'ARCHIVE_SOFT_DELETED',
    ARCHIVE_HARD_DELETED: 'ARCHIVE_HARD_DELETED',
    ARCHIVE_UNDELETED: 'ARCHIVE_UNDELETED',
    EVIDENCE_BUNDLE_CREATED: 'EVIDENCE_BUNDLE_CREATED',
    EVIDENCE_BUNDLE_DOWNLOADED: 'EVIDENCE_BUNDLE_DOWNLOADED',
    EVIDENCE_BUNDLE_VERIFIED: 'EVIDENCE_BUNDLE_VERIFIED'
};

// Audit actors
const AUDIT_ACTORS = {
    SYSTEM: 'system',
    REVIEWER: 'reviewer',
    ADMIN: 'admin',
    AUTO: 'auto'
};

// Correlation ID context (thread-local storage)
let correlationIdContext = null;

/**
 * Set current correlation ID for this execution context
 */
function setCorrelationId(id) {
    correlationIdContext = id;
}

/**
 * Get or generate correlation ID
 */
function getCorrelationId() {
    if (correlationIdContext) {
        return correlationIdContext;
    }
    return generateUUID();
}

/**
 * Clear correlation ID context
 */
function clearCorrelationId() {
    correlationIdContext = null;
}

/**
 * Create a new correlation ID and set as current
 */
function createNewCorrelationId() {
    const id = generateUUID();
    setCorrelationId(id);
    return id;
}

/**
 * Log an audit action
 * @param {string} action - Action type from AUDIT_ACTIONS
 * @param {string|null} attachmentId - Attachment ID (nullable for message-level)
 * @param {string} actor - Actor from AUDIT_ACTORS or custom
 * @param {object} details - Additional context
 * @param {string|null} messageId - Message ID (optional)
 * @returns {string} - Audit entry ID
 */
function logAction(action, attachmentId, actor, details = {}, messageId = null) {
    const correlationId = getCorrelationId();
    const timestamp = new Date().toISOString();

    const auditId = logAudit({
        action,
        attachment_id: attachmentId,
        message_id: messageId,
        actor,
        timestamp,
        details,
        correlation_id: correlationId
    });

    // Also write to JSONL backup file
    writeAuditToFile({
        id: auditId,
        attachment_id: attachmentId,
        message_id: messageId,
        action,
        actor,
        timestamp,
        details,
        correlation_id: correlationId
    });

    return auditId;
}

/**
 * Log INGEST action (message received)
 */
function logIngest(messageId, details = {}) {
    return logAction(AUDIT_ACTIONS.INGEST, null, AUDIT_ACTORS.SYSTEM, {
        ...details,
        messageId
    }, messageId);
}

/**
 * Log NORMALISE action (file processed)
 */
function logNormalise(attachmentId, details = {}) {
    return logAction(AUDIT_ACTIONS.NORMALISE, attachmentId, AUDIT_ACTORS.SYSTEM, {
        ...details,
        canonicalFilename: details.canonicalFilename,
        storagePath: details.storagePath,
        contentHash: details.contentHash
    });
}

/**
 * Log CLASSIFY action (POD classification)
 */
function logClassify(attachmentId, isPod, confidence, details = {}) {
    return logAction(AUDIT_ACTIONS.CLASSIFY, attachmentId, AUDIT_ACTORS.AUTO, {
        ...details,
        isPod,
        confidence
    });
}

/**
 * Log MATCH action (job reference matched)
 */
function logMatch(attachmentId, jobRef, confidence, details = {}) {
    return logAction(AUDIT_ACTIONS.MATCH, attachmentId, AUDIT_ACTORS.AUTO, {
        ...details,
        jobRef,
        confidence
    });
}

/**
 * Log ROUTE action (routed to queue)
 */
function logRoute(attachmentId, queue, details = {}) {
    return logAction(AUDIT_ACTIONS.ROUTE, attachmentId, AUDIT_ACTORS.SYSTEM, {
        ...details,
        queue
    });
}

/**
 * Log REVIEW action (manual review)
 */
function logReview(attachmentId, reviewer, action, details = {}) {
    return logAction(AUDIT_ACTIONS.REVIEW, attachmentId, reviewer, {
        ...details,
        action
    });
}

/**
 * Log EXPORT action (sent to recipients)
 */
function logExport(attachmentId, recipients, details = {}) {
    return logAction(AUDIT_ACTIONS.EXPORT, attachmentId, AUDIT_ACTORS.SYSTEM, {
        ...details,
        recipients,
        exportedAt: new Date().toISOString()
    });
}

/**
 * Log EXPORT_PREPARE action (export record created)
 */
function logExportPrepared(attachmentId, exportId, details = {}) {
    return logAction(AUDIT_ACTIONS.EXPORT_PREPARED, attachmentId, AUDIT_ACTORS.SYSTEM, {
        ...details,
        exportId,
        preparedAt: new Date().toISOString()
    });
}

/**
 * Log EXPORT_QUEUED action (added to email queue for Phase 3)
 */
function logExportQueued(attachmentId, exportId, recipients, details = {}) {
    return logAction(AUDIT_ACTIONS.EXPORT_QUEUED, attachmentId, AUDIT_ACTORS.SYSTEM, {
        ...details,
        exportId,
        recipients,
        queuedAt: new Date().toISOString()
    });
}

/**
 * Log FAILED action (error occurred)
 */
function logFailed(attachmentId, error, details = {}) {
    return logAction(AUDIT_ACTIONS.FAILED, attachmentId, AUDIT_ACTORS.SYSTEM, {
        ...details,
        error: error.message || error,
        failedAt: new Date().toISOString()
    });
}

/**
 * Get audit trail for an attachment
 */
function getAttachmentAuditTrail(attachmentId) {
    return getAuditTrail(attachmentId);
}

/**
 * Get audit trail by correlation ID
 */
function getCorrelationAuditTrail() {
    const correlationId = getCorrelationId();
    return getAuditTrailByCorrelationId(correlationId);
}

// JSONL file path for audit backup
const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR || '/mnt/storage/logs/audit';

/**
 * Ensure audit log directory exists
 */
function ensureAuditLogDir() {
    if (!fs.existsSync(AUDIT_LOG_DIR)) {
        fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
    }
}

/**
 * Get current audit log file path (rotated daily)
 */
function getAuditLogPath() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    return path.join(AUDIT_LOG_DIR, `audit-${dateStr}.jsonl`);
}

/**
 * Write audit entry to JSONL file
 */
function writeAuditToFile(entry) {
    try {
        ensureAuditLogDir();
        const logPath = getAuditLogPath();
        const line = JSON.stringify(entry) + '\n';
        fs.appendFileSync(logPath, line);
    } catch (err) {
        console.error('Failed to write audit to file:', err.message);
        // Don't fail - DB write is primary
    }
}

/**
 * Query audit logs from file (for recovery/debugging)
 */
function queryAuditLogs(fromDate, toDate = null) {
    const results = [];

    if (!fs.existsSync(AUDIT_LOG_DIR)) {
        return results;
    }

    const files = fs.readdirSync(AUDIT_LOG_DIR).filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'));

    for (const file of files) {
        const fileDate = file.replace('audit-', '').replace('.jsonl', '');
        if (fileDate < fromDate) continue;
        if (toDate && fileDate > toDate) continue;

        const filePath = path.join(AUDIT_LOG_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        for (const line of content.trim().split('\n')) {
            if (line) {
                try {
                    results.push(JSON.parse(line));
                } catch {
                    // Skip malformed lines
                }
            }
        }
    }

    return results.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

module.exports = {
    AUDIT_ACTIONS,
    AUDIT_ACTORS,
    setCorrelationId,
    getCorrelationId,
    clearCorrelationId,
    createNewCorrelationId,
    logAction,
    logIngest,
    logNormalise,
    logClassify,
    logMatch,
    logRoute,
    logReview,
    logExport,
    logExportPrepared,
    logExportQueued,
    logFailed,
    getAttachmentAuditTrail,
    getCorrelationAuditTrail,
    queryAuditLogs
};
