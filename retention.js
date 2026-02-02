/**
 * Retention Policy Management Module
 *
 * Handles retention schedules, expiry detection, and cleanup operations
 * for compliant data lifecycle management.
 */

const { getDb } = require('./db');
const { logAudit, getAuditTrail } = require('./models');
const { generateUUID } = require('./models');

// Audit actions for retention
const RETENTION_AUDIT_ACTIONS = {
    POLICY_APPLIED: 'RETENTION_POLICY_APPLIED',
    EXPIRED_CHECK: 'RETENTION_EXPIRED_CHECK',
    ARCHIVE_CANDIDATE: 'RETENTION_ARCHIVE_CANDIDATE',
    CLEANUP_RUN: 'RETENTION_CLEANUP_RUN',
    CLEANUP_APPLIED: 'RETENTION_CLEANUP_APPLIED'
};

// Default retention policies (configurable via RETENTION_POLICIES env var)
const DEFAULT_POLICIES = [
    {
        policy_id: 'pods_1yr',
        name: 'PODs 1 Year',
        description: 'Proof of Delivery attachments - 1 year retention',
        retention_days: 365,
        archive_before_delete: true,
        grace_days: 30,
        applies_to: ['attachments'],
        is_active: true
    },
    {
        policy_id: 'exports_2yr',
        name: 'Exports 2 Years',
        description: 'Export records - 2 year retention',
        retention_days: 730,
        archive_before_delete: true,
        grace_days: 30,
        applies_to: ['exports'],
        is_active: true
    },
    {
        policy_id: 'email_90d',
        name: 'Email Queue 90 Days',
        description: 'Email queue entries - 90 day retention',
        retention_days: 90,
        archive_before_delete: false,
        grace_days: 7,
        applies_to: ['email_queue'],
        is_active: true
    },
    {
        policy_id: 'audit_7yr',
        name: 'Audit Logs 7 Years',
        description: 'Audit log entries - 7 year retention for compliance',
        retention_days: 2555,
        archive_before_delete: true,
        grace_days: 90,
        applies_to: ['audit_logs'],
        is_active: true
    }
];

// In-memory policy store (can be replaced with database storage)
let retentionPolicies = [];

/**
 * Initialize retention module - load policies from environment or defaults
 */
function init() {
    const envPolicies = process.env.RETENTION_POLICIES;

    if (envPolicies) {
        try {
            retentionPolicies = JSON.parse(envPolicies);
            console.log(`Loaded ${retentionPolicies.length} retention policies from environment`);
        } catch (e) {
            console.error('Failed to parse RETENTION_POLICIES, using defaults:', e.message);
            retentionPolicies = [...DEFAULT_POLICIES];
        }
    } else {
        retentionPolicies = [...DEFAULT_POLICIES];
    }
}

/**
 * Get all retention policies
 */
function getPolicies() {
    return retentionPolicies.filter(p => p.is_active);
}

/**
 * Get a specific policy by ID
 */
function getPolicy(policyId) {
    return retentionPolicies.find(p => p.policy_id === policyId);
}

/**
 * Get the applicable policy for an attachment based on its type
 */
function getApplicablePolicy(attachment) {
    const policies = getPolicies();

    // Determine attachment type
    let attachmentType = 'attachments';
    if (attachment.file_type?.startsWith('image/')) {
        attachmentType = 'attachments';
    } else if (attachment.metadata?.export_record) {
        attachmentType = 'exports';
    }

    // Find matching policy
    return policies.find(p =>
        p.applies_to.includes(attachmentType) ||
        p.applies_to.includes('attachments')
    );
}

/**
 * Calculate retention expiry date for an attachment
 */
function getRetentionExpiry(attachment) {
    const policy = getApplicablePolicy(attachment);

    if (!policy) {
        return {
            hasPolicy: false,
            message: 'No applicable retention policy found'
        };
    }

    const createdAt = new Date(attachment.created_at);
    const expiryDate = new Date(createdAt);
    expiryDate.setDate(expiryDate.getDate() + policy.retention_days);

    const graceExpiry = new Date(expiryDate);
    graceExpiry.setDate(graceExpiry.getDate() + (policy.grace_days || 30));

    const now = new Date();
    const isExpired = now >= expiryDate;
    const inGracePeriod = now >= expiryDate && now < graceExpiry;
    const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
    const daysUntilGraceExpiry = Math.ceil((graceExpiry - now) / (1000 * 60 * 60 * 24));

    return {
        hasPolicy: true,
        policy: {
            id: policy.policy_id,
            name: policy.name,
            retention_days: policy.retention_days,
            grace_days: policy.grace_days || 30,
            archive_before_delete: policy.archive_before_delete
        },
        created_at: attachment.created_at,
        expiry_date: expiryDate.toISOString(),
        grace_expiry_date: graceExpiry.toISOString(),
        is_expired: isExpired,
        in_grace_period: inGracePeriod,
        days_until_expiry: daysUntilExpiry > 0 ? daysUntilExpiry : 0,
        days_until_grace_expiry: daysUntilGraceExpiry > 0 ? daysUntilGraceExpiry : 0,
        archive_eligible: isExpired && policy.archive_before_delete,
        delete_eligible: inGracePeriod && !policy.archive_before_delete
    };
}

/**
 * Check if an attachment's retention period has expired
 */
function isRetentionPeriodExpired(attachment) {
    const expiry = getRetentionExpiry(attachment);
    return expiry.is_expired === true;
}

/**
 * Get attachments eligible for archive (past retention, not on hold)
 */
function getAttachmentsEligibleForArchive(options = {}) {
    const db = getDb();
    const { limit = 100 } = options;

    const now = new Date().toISOString();

    // Find attachments past retention period, not archived, not on legal hold
    const stmt = db.prepare(`
        SELECT a.*, m.sender_id, m.received_at as message_received_at
        FROM attachments a
        JOIN messages m ON a.message_id = m.id
        WHERE a.status NOT IN ('ARCHIVED', 'DELETED')
        AND a.created_at < datetime(?, '-365 days')
        AND NOT EXISTS (
            SELECT 1 FROM legal_holds lh
            WHERE lh.attachment_id = a.id
            AND lh.status = 'ACTIVE'
            AND (lh.expires_at IS NULL OR lh.expires_at > ?)
        )
        ORDER BY a.created_at ASC
        LIMIT ?
    `);

    return stmt.all(now, now, limit).map(row => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        retention: getRetentionExpiry(row)
    }));
}

/**
 * Get attachments eligible for deletion (past archive + grace period)
 */
function getAttachmentsEligibleForDelete(options = {}) {
    const db = getDb();
    const { limit = 100 } = options;

    const now = new Date().toISOString();
    const graceExpiry = new Date();
    graceExpiry.setDate(graceExpiry.getDate() - 30); // 30 days past retention
    const graceExpiryStr = graceExpiry.toISOString();

    // Find attachments past retention + grace period, not on legal hold
    const stmt = db.prepare(`
        SELECT a.*, m.sender_id, m.received_at as message_received_at
        FROM attachments a
        JOIN messages m ON a.message_id = m.id
        WHERE a.status NOT IN ('DELETED')
        AND a.created_at < ?
        AND NOT EXISTS (
            SELECT 1 FROM legal_holds lh
            WHERE lh.attachment_id = a.id
            AND lh.status = 'ACTIVE'
            AND (lh.expires_at IS NULL OR lh.expires_at > ?)
        )
        ORDER BY a.created_at ASC
        LIMIT ?
    `);

    return stmt.all(graceExpiryStr, now, limit).map(row => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        retention: getRetentionExpiry(row)
    }));
}

/**
 * Set or update a retention rule
 */
function setRule(ruleData) {
    const policyId = ruleData.policy_id || generateUUID();

    const policy = {
        policy_id: policyId,
        name: ruleData.name || 'Custom Policy',
        description: ruleData.description || '',
        retention_days: ruleData.retention_days || 365,
        archive_before_delete: ruleData.archive_before_delete !== false,
        grace_days: ruleData.grace_days || 30,
        applies_to: ruleData.applies_to || ['attachments'],
        is_active: ruleData.is_active !== false,
        created_at: new Date().toISOString()
    };

    // Update or add policy
    const existingIndex = retentionPolicies.findIndex(p => p.policy_id === policyId);
    if (existingIndex >= 0) {
        retentionPolicies[existingIndex] = { ...retentionPolicies[existingIndex], ...policy };
    } else {
        retentionPolicies.push(policy);
    }

    return policy;
}

/**
 * Log retention policy application
 */
function logRetentionPolicyApplied(attachmentId, policyId, action, details = {}) {
    const db = getDb();
    const id = generateUUID();

    db.prepare(`
        INSERT INTO audit_logs (id, attachment_id, action, actor, timestamp, details)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        id,
        attachmentId,
        `${RETENTION_AUDIT_ACTIONS.POLICY_APPLIED}_${action}`,
        'system',
        new Date().toISOString(),
        JSON.stringify({ policy_id: policyId, ...details })
    );

    return id;
}

/**
 * Get retention statistics
 */
function getStats() {
    const db = getDb();

    const totalAttachments = db.prepare('SELECT COUNT(*) as count FROM attachments').get().count;
    const archivedAttachments = db.prepare("SELECT COUNT(*) as count FROM attachments WHERE status = 'ARCHIVED'").get().count;
    const deletedAttachments = db.prepare("SELECT COUNT(*) as count FROM attachments WHERE status = 'DELETED'").get().count;
    const expiredCount = getAttachmentsEligibleForDelete({ limit: 10000 }).length;
    const archiveEligibleCount = getAttachmentsEligibleForArchive({ limit: 10000 }).length;

    return {
        total: totalAttachments,
        archived: archivedAttachments,
        deleted: deletedAttachments,
        expired_eligible_for_delete: expiredCount,
        archive_eligible: archiveEligibleCount,
        active_policies: getPolicies().length
    };
}

/**
 * Apply retention action to a single attachment
 */
async function applyRetention(attachmentId, options = {}) {
    const { dryRun = false } = options;
    const db = getDb();

    const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId);
    if (!attachment) {
        throw new Error('Attachment not found');
    }

    const retention = getRetentionExpiry(attachment);

    if (!retention.hasPolicy) {
        throw new Error('No applicable retention policy');
    }

    if (!retention.is_expired) {
        throw new Error('Retention period not yet expired');
    }

    // Check if on legal hold
    const onHold = db.prepare(`
        SELECT COUNT(*) as count FROM legal_holds
        WHERE attachment_id = ? AND status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(attachmentId, new Date().toISOString()).count > 0;

    if (onHold) {
        throw new Error('Attachment is under legal hold');
    }

    const result = {
        attachment_id: attachmentId,
        retention,
        action: null,
        would_change: !dryRun
    };

    if (retention.archive_eligible && retention.policy.archive_before_delete) {
        result.action = 'archive';
        if (!dryRun) {
            db.prepare("UPDATE attachments SET status = 'ARCHIVED' WHERE id = ?").run(attachmentId);
            logRetentionPolicyApplied(attachmentId, retention.policy.id, 'ARCHIVED', {
                expiry_date: retention.expiry_date,
                grace_expiry: retention.grace_expiry_date
            });
        }
    } else if (retention.in_grace_period) {
        result.action = 'soft_delete';
        if (!dryRun) {
            db.prepare("UPDATE attachments SET status = 'PENDING_DELETE' WHERE id = ?").run(attachmentId);
            logRetentionPolicyApplied(attachmentId, retention.policy.id, 'SOFT_DELETE', {
                grace_expiry: retention.grace_expiry_date
            });
        }
    } else {
        result.action = 'hard_delete';
        if (!dryRun) {
            db.prepare("UPDATE attachments SET status = 'DELETED' WHERE id = ?").run(attachmentId);
            logRetentionPolicyApplied(attachmentId, retention.policy.id, 'HARD_DELETE', {});
        }
    }

    return result;
}

/**
 * Run retention cleanup job
 */
async function runCleanup(options = {}) {
    const { dryRun = false, limit = 100 } = options;

    const archiveEligible = getAttachmentsEligibleForArchive({ limit });
    const deleteEligible = getAttachmentsEligibleForDelete({ limit });

    const results = {
        dry_run: dryRun,
        archive_count: archiveEligible.length,
        delete_count: deleteEligible.length,
        archived: [],
        deleted: [],
        errors: []
    };

    // Process archive candidates
    for (const attachment of archiveEligible) {
        try {
            if (!dryRun) {
                await applyRetention(attachment.id, { dryRun: false });
            }
            results.archived.push({
                id: attachment.id,
                created_at: attachment.created_at
            });
        } catch (error) {
            results.errors.push({
                attachment_id: attachment.id,
                error: error.message
            });
        }
    }

    // Process delete candidates
    for (const attachment of deleteEligible) {
        try {
            if (!dryRun) {
                await applyRetention(attachment.id, { dryRun: false });
            }
            results.deleted.push({
                id: attachment.id,
                created_at: attachment.created_at
            });
        } catch (error) {
            results.errors.push({
                attachment_id: attachment.id,
                error: error.message
            });
        }
    }

    // Log cleanup run
    const db = getDb();
    const id = generateUUID();
    db.prepare(`
        INSERT INTO audit_logs (id, attachment_id, action, actor, timestamp, details)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        id,
        null,
        RETENTION_AUDIT_ACTIONS.CLEANUP_RUN,
        'system',
        new Date().toISOString(),
        JSON.stringify({
            dry_run: dryRun,
            archive_count: results.archive_count,
            delete_count: results.delete_count,
            error_count: results.errors.length
        })
    );

    return results;
}

module.exports = {
    init,
    getPolicies,
    getPolicy,
    getApplicablePolicy,
    getRetentionExpiry,
    isRetentionPeriodExpired,
    getAttachmentsEligibleForArchive,
    getAttachmentsEligibleForDelete,
    setRule,
    getStats,
    applyRetention,
    runCleanup,
    RETENTION_AUDIT_ACTIONS
};
