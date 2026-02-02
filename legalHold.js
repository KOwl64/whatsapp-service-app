/**
 * Legal Hold Management Module
 *
 * Handles legal holds to protect attachments from deletion
 * for compliance and legal proceedings.
 */

const { getDb } = require('./db');
const { getAttachmentById, generateUUID } = require('./models');

// Audit actions for legal holds
const LEGAL_HOLD_AUDIT_ACTIONS = {
    CREATED: 'LEGAL_HOLD_CREATED',
    RELEASED: 'LEGAL_HOLD_RELEASED',
    EXPIRED: 'LEGAL_HOLD_EXPIRED',
    APPLIED: 'LEGAL_HOLD_APPLIED'
};

/**
 * Initialize legal hold module
 */
function init() {
    console.log('Legal Hold module initialized');
}

/**
 * Create a new legal hold on an attachment
 */
function createLegalHold(attachmentId, reason, createdBy, options = {}) {
    const { expiresAt = null, notes = null } = options;
    const db = getDb();

    // Verify attachment exists
    const attachment = getAttachmentById(attachmentId);
    if (!attachment) {
        throw new Error('Attachment not found');
    }

    // Check for existing ACTIVE hold
    const existingHold = db.prepare(`
        SELECT id FROM legal_holds
        WHERE attachment_id = ? AND status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(attachmentId, new Date().toISOString());

    if (existingHold) {
        throw new Error('Attachment already has an active legal hold');
    }

    const holdId = generateUUID();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO legal_holds (id, attachment_id, status, reason, created_by, created_at, expires_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        holdId,
        attachmentId,
        'ACTIVE',
        reason,
        createdBy,
        now,
        expiresAt,
        notes
    );

    // Log to audit
    logLegalHoldAction(holdId, attachmentId, LEGAL_HOLD_AUDIT_ACTIONS.CREATED, {
        reason,
        created_by: createdBy,
        expires_at: expiresAt,
        notes
    });

    return {
        id: holdId,
        attachment_id: attachmentId,
        status: 'ACTIVE',
        reason,
        created_by: createdBy,
        created_at: now,
        expires_at: expiresAt,
        notes
    };
}

/**
 * Apply legal hold (alias for createLegalHold for API compatibility)
 */
function applyHold(attachmentId, options = {}) {
    const { reason, expiresAt = null, notes = null } = options;
    const createdBy = options.createdBy || options.created_by || 'system';
    return createLegalHold(attachmentId, reason, createdBy, { expiresAt, notes });
}

/**
 * Release a legal hold
 */
function releaseLegalHold(holdId, releasedBy, releaseReason) {
    const db = getDb();

    const hold = db.prepare('SELECT * FROM legal_holds WHERE id = ?').get(holdId);
    if (!hold) {
        throw new Error('Legal hold not found');
    }

    if (hold.status !== 'ACTIVE') {
        throw new Error('Legal hold is not active');
    }

    const now = new Date().toISOString();

    db.prepare(`
        UPDATE legal_holds
        SET status = 'RELEASED', released_by = ?, released_at = ?, release_reason = ?
        WHERE id = ?
    `).run(releasedBy, now, releaseReason, holdId);

    // Log to audit
    logLegalHoldAction(holdId, hold.attachment_id, LEGAL_HOLD_AUDIT_ACTIONS.RELEASED, {
        released_by: releasedBy,
        release_reason: releaseReason,
        duration_days: Math.ceil((new Date(now) - new Date(hold.created_at)) / (1000 * 60 * 60 * 24))
    });

    return {
        id: holdId,
        attachment_id: hold.attachment_id,
        status: 'RELEASED',
        reason: hold.reason,
        created_by: hold.created_by,
        created_at: hold.created_at,
        expires_at: hold.expires_at,
        released_by: releasedBy,
        released_at: now,
        release_reason: releaseReason
    };
}

/**
 * Get all active legal holds
 */
function getActiveHolds(options = {}) {
    const { limit = 100, offset = 0 } = options;
    const db = getDb();

    const now = new Date().toISOString();

    const stmt = db.prepare(`
        SELECT lh.*, a.original_filename, a.canonical_filename, a.storage_uri
        FROM legal_holds lh
        JOIN attachments a ON lh.attachment_id = a.id
        WHERE lh.status = 'ACTIVE'
        AND (lh.expires_at IS NULL OR lh.expires_at > ?)
        ORDER BY lh.created_at DESC
        LIMIT ? OFFSET ?
    `);

    return stmt.all(now, limit, offset).map(row => ({
        ...row,
        notes: row.notes ? JSON.parse(row.notes) : null
    }));
}

/**
 * Get all holds (any status)
 */
function getAllHolds(options = {}) {
    const { limit = 100, offset = 0, status = null } = options;
    const db = getDb();

    let query = `
        SELECT lh.*, a.original_filename, a.canonical_filename
        FROM legal_holds lh
        JOIN attachments a ON lh.attachment_id = a.id
    `;
    const params = [];

    if (status) {
        query += ' WHERE lh.status = ?';
        params.push(status);
    }

    query += ' ORDER BY lh.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(query);
    return stmt.all(...params).map(row => ({
        ...row,
        notes: row.notes ? JSON.parse(row.notes) : null
    }));
}

/**
 * Get holds for a specific attachment
 */
function getAttachmentHolds(attachmentId) {
    const db = getDb();

    const holds = db.prepare(`
        SELECT * FROM legal_holds
        WHERE attachment_id = ?
        ORDER BY created_at DESC
    `).all(attachmentId);

    const now = new Date().toISOString();

    return holds.map(hold => ({
        ...hold,
        is_expired: hold.expires_at && new Date(hold.expires_at) < new Date(now),
        notes: hold.notes ? JSON.parse(hold.notes) : null
    }));
}

/**
 * Check if an attachment is protected by any active legal hold
 */
function isProtected(attachmentId) {
    const db = getDb();
    const now = new Date().toISOString();

    const count = db.prepare(`
        SELECT COUNT(*) as count FROM legal_holds
        WHERE attachment_id = ? AND status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(attachmentId, now).count;

    return count > 0;
}

/**
 * Get expired holds (past expiry date but still marked ACTIVE)
 */
function getExpiredHolds() {
    const db = getDb();
    const now = new Date().toISOString();

    return db.prepare(`
        SELECT lh.*, a.original_filename, a.canonical_filename
        FROM legal_holds lh
        JOIN attachments a ON lh.attachment_id = a.id
        WHERE lh.status = 'ACTIVE'
        AND lh.expires_at IS NOT NULL
        AND lh.expires_at <= ?
        ORDER BY lh.expires_at ASC
    `).all(now).map(row => ({
        ...row,
        notes: row.notes ? JSON.parse(row.notes) : null
    }));
}

/**
 * Get legal hold statistics
 */
function getStats() {
    const db = getDb();
    const now = new Date().toISOString();

    const activeCount = db.prepare(`
        SELECT COUNT(*) as count FROM legal_holds
        WHERE status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(now).count;

    const expiredCount = db.prepare(`
        SELECT COUNT(*) as count FROM legal_holds
        WHERE status = 'ACTIVE'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).get(now).count;

    const releasedCount = db.prepare(`
        SELECT COUNT(*) as count FROM legal_holds
        WHERE status = 'RELEASED'
    `).get().count;

    const totalCount = db.prepare('SELECT COUNT(*) as count FROM legal_holds').get().count;

    return {
        active: activeCount,
        expired: expiredCount,
        released: releasedCount,
        total: totalCount
    };
}

/**
 * Log legal hold action to audit
 */
function logLegalHoldAction(holdId, attachmentId, action, details = {}) {
    const db = getDb();
    const id = generateUUID();

    db.prepare(`
        INSERT INTO audit_logs (id, attachment_id, action, actor, timestamp, details)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        id,
        attachmentId,
        action,
        'system',
        new Date().toISOString(),
        JSON.stringify({ hold_id: holdId, ...details })
    );

    return id;
}

/**
 * Update expired holds (mark them as expired in audit)
 */
function checkAndLogExpiredHolds() {
    const expiredHolds = getExpiredHolds();

    for (const hold of expiredHolds) {
        logLegalHoldAction(hold.id, hold.attachment_id, LEGAL_HOLD_AUDIT_ACTIONS.EXPIRED, {
            expired_at: new Date().toISOString(),
            original_expiry: hold.expires_at
        });
    }

    return expiredHolds.length;
}

module.exports = {
    init,
    createLegalHold,
    applyHold,
    releaseLegalHold,
    getActiveHolds,
    getAllHolds,
    getAttachmentHolds,
    isProtected,
    isProtected, // Alias for API compatibility
    getExpiredHolds,
    getStats,
    checkAndLogExpiredHolds,
    LEGAL_HOLD_AUDIT_ACTIONS
};
