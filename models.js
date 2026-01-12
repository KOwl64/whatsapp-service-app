const crypto = require('crypto');
const { getDb } = require('./db');

function generateUUID() {
    return crypto.randomUUID();
}

// Message operations
function createMessage(messageData) {
    const db = getDb();
    const id = messageData.id || generateUUID();
    const correlationId = messageData.correlation_id || generateUUID();

    const stmt = db.prepare(`
        INSERT INTO messages (id, source, chat_id, sender_id, received_at, raw_payload_ref, status, correlation_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        id,
        messageData.source || 'whatsapp',
        messageData.chat_id,
        messageData.sender_id,
        messageData.received_at,
        messageData.raw_payload_ref,
        messageData.status || 'PENDING',
        correlationId,
        messageData.metadata ? JSON.stringify(messageData.metadata) : null
    );

    return { id, correlation_id: correlationId, ...messageData };
}

function getMessageById(id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM messages WHERE id = ?');
    const row = stmt.get(id);

    if (!row) return null;

    // Get attachments for this message
    const attachStmt = db.prepare('SELECT * FROM attachments WHERE message_id = ?');
    const attachments = attachStmt.all(id);

    return {
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        attachments
    };
}

function getMessagesByStatus(status, limit = 100) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM messages WHERE status = ? ORDER BY received_at DESC LIMIT ?');
    return stmt.all(status, limit);
}

// Attachment operations
function createAttachment(attachmentData) {
    const db = getDb();
    const id = attachmentData.id || generateUUID();

    const stmt = db.prepare(`
        INSERT INTO attachments (id, message_id, content_hash, file_type, file_size, original_filename, storage_uri, canonical_filename, status, job_ref, vehicle_reg, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        id,
        attachmentData.message_id,
        attachmentData.content_hash,
        attachmentData.file_type,
        attachmentData.file_size,
        attachmentData.original_filename,
        attachmentData.storage_uri,
        attachmentData.canonical_filename,
        attachmentData.status || 'REVIEW',
        attachmentData.job_ref || null,
        attachmentData.vehicle_reg || null,
        attachmentData.metadata ? JSON.stringify(attachmentData.metadata) : null
    );

    return { id, ...attachmentData };
}

function getAttachmentById(id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM attachments WHERE id = ?');
    const row = stmt.get(id);

    if (!row) return null;

    return {
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null
    };
}

function getAttachmentByHash(contentHash) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM attachments WHERE content_hash = ?');
    return stmt.get(contentHash);
}

function updateAttachmentStatus(id, status, extraFields = {}) {
    const db = getDb();
    let setClause = 'status = ?';
    const params = [status];

    if (extraFields.job_ref !== undefined) {
        setClause += ', job_ref = ?';
        params.push(extraFields.job_ref);
    }
    if (extraFields.vehicle_reg !== undefined) {
        setClause += ', vehicle_reg = ?';
        params.push(extraFields.vehicle_reg);
    }

    params.push(id);

    const stmt = db.prepare(`UPDATE attachments SET ${setClause} WHERE id = ?`);
    return stmt.run(...params);
}

// Queue queries
function getAttachmentsForReview(limit = 100) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT a.*, m.sender_id, m.received_at as message_received_at
        FROM attachments a
        JOIN messages m ON a.message_id = m.id
        WHERE a.status = 'REVIEW'
        ORDER BY a.created_at ASC
        LIMIT ?
    `);
    return stmt.all(limit);
}

function getAttachmentsForOut(limit = 100) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT a.*, m.sender_id, m.received_at as message_received_at
        FROM attachments a
        JOIN messages m ON a.message_id = m.id
        WHERE a.status = 'OUT'
        ORDER BY a.created_at ASC
        LIMIT ?
    `);
    return stmt.all(limit);
}

function getAttachmentsByStatus(status, limit = 100) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT a.*, m.sender_id, m.received_at as message_received_at
        FROM attachments a
        JOIN messages m ON a.message_id = m.id
        WHERE a.status = ?
        ORDER BY a.created_at ASC
        LIMIT ?
    `);
    return stmt.all(status, limit);
}

// Audit operations
function logAudit(auditData) {
    const db = getDb();
    const id = auditData.id || generateUUID();

    const stmt = db.prepare(`
        INSERT INTO audit_logs (id, attachment_id, message_id, action, actor, timestamp, details, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        id,
        auditData.attachment_id || null,
        auditData.message_id || null,
        auditData.action,
        auditData.actor,
        auditData.timestamp || new Date().toISOString(),
        auditData.details ? JSON.stringify(auditData.details) : null,
        auditData.correlation_id || null
    );

    return id;
}

function getAuditTrail(attachmentId) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT * FROM audit_logs
        WHERE attachment_id = ?
        ORDER BY timestamp ASC
    `);
    return stmt.all(attachmentId).map(row => ({
        ...row,
        details: row.details ? JSON.parse(row.details) : null
    }));
}

function getAuditTrailByCorrelationId(correlationId) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT * FROM audit_logs
        WHERE correlation_id = ?
        ORDER BY timestamp ASC
    `);
    return stmt.all(correlationId).map(row => ({
        ...row,
        details: row.details ? JSON.parse(row.details) : null
    }));
}

// ============================================
// Export operations (Phase 3 prep)
// ============================================

function createExport(exportData) {
    const db = getDb();
    const id = exportData.id || generateUUID();

    const stmt = db.prepare(`
        INSERT INTO exports (id, attachment_id, message_id, export_type, status, recipients, subject, body, attachments_ref, exported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        id,
        exportData.attachment_id,
        exportData.message_id || null,
        exportData.export_type || 'MANUAL',
        exportData.status || 'PENDING',
        exportData.recipients ? JSON.stringify(exportData.recipients) : null,
        exportData.subject || null,
        exportData.body || null,
        exportData.attachments_ref || null,
        exportData.exported_at || new Date().toISOString()
    );

    return { id, ...exportData };
}

function getExportById(id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM exports WHERE id = ?');
    const row = stmt.get(id);

    if (!row) return null;

    return {
        ...row,
        recipients: row.recipients ? JSON.parse(row.recipients) : null
    };
}

function getExportByIdWithAttachment(id) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT e.*, a.storage_uri, a.canonical_filename, a.original_filename,
               a.job_ref, a.vehicle_reg, a.file_type, a.file_size
        FROM exports e
        JOIN attachments a ON e.attachment_id = a.id
        WHERE e.id = ?
    `);
    const row = stmt.get(id);

    if (!row) return null;

    return {
        ...row,
        recipients: row.recipients ? JSON.parse(row.recipients) : null
    };
}

function getExportsByStatus(status, limit = 100) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM exports WHERE status = ? ORDER BY created_at DESC LIMIT ?');
    return stmt.all(status, limit).map(row => ({
        ...row,
        recipients: row.recipients ? JSON.parse(row.recipients) : null
    }));
}

function getPendingExports() {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT e.*, a.storage_uri, a.canonical_filename, a.original_filename,
               a.job_ref, a.vehicle_reg, a.file_type, a.file_size
        FROM exports e
        JOIN attachments a ON e.attachment_id = a.id
        WHERE e.status = 'PENDING'
        ORDER BY e.created_at ASC
    `);
    return stmt.all().map(row => ({
        ...row,
        recipients: row.recipients ? JSON.parse(row.recipients) : null
    }));
}

function getAllExports(options = {}) {
    const db = getDb();
    const { status, limit = 100, offset = 0 } = options;

    let query = 'SELECT * FROM exports';
    const params = [];

    if (status) {
        query += ' WHERE status = ?';
        params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(query);
    return stmt.all(...params).map(row => ({
        ...row,
        recipients: row.recipients ? JSON.parse(row.recipients) : null
    }));
}

function updateExportStatus(id, status, extraFields = {}) {
    const db = getDb();
    let setClause = 'status = ?';
    const params = [status];

    if (extraFields.error !== undefined) {
        setClause += ', error = ?';
        params.push(extraFields.error);
    }
    if (extraFields.delivered_at !== undefined) {
        setClause += ', delivered_at = ?';
        params.push(extraFields.delivered_at);
    }

    params.push(id);

    const stmt = db.prepare(`UPDATE exports SET ${setClause} WHERE id = ?`);
    return stmt.run(...params);
}

function markExportDelivered(id) {
    return updateExportStatus(id, 'DELIVERED', {
        delivered_at: new Date().toISOString()
    });
}

function markExportFailed(id, error) {
    return updateExportStatus(id, 'FAILED', { error });
}

function getExportsByAttachmentId(attachmentId) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM exports WHERE attachment_id = ? ORDER BY created_at DESC');
    return stmt.all(attachmentId).map(row => ({
        ...row,
        recipients: row.recipients ? JSON.parse(row.recipients) : null
    }));
}

module.exports = {
    generateUUID,
    createMessage,
    getMessageById,
    getMessagesByStatus,
    createAttachment,
    getAttachmentById,
    getAttachmentByHash,
    updateAttachmentStatus,
    getAttachmentsForReview,
    getAttachmentsForOut,
    getAttachmentsByStatus,
    logAudit,
    getAuditTrail,
    getAuditTrailByCorrelationId,
    // Export functions
    createExport,
    getExportById,
    getExportByIdWithAttachment,
    getExportsByStatus,
    getPendingExports,
    getAllExports,
    updateExportStatus,
    markExportDelivered,
    markExportFailed,
    getExportsByAttachmentId
};
