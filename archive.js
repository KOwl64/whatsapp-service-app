/**
 * Archive and Delete Workflow Module
 *
 * Handles archival and deletion of attachments with full audit trail
 * and restoration capabilities.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./db');
const { getAttachmentById, generateUUID } = require('./models');
const { isProtected } = require('./legalHold');

// Archive configuration
const ARCHIVE_BASE_PATH = process.env.ARCHIVE_BASE_PATH || '/data/whatsapp-archives';
const ARCHIVE_TEMP_PATH = path.join(ARCHIVE_BASE_PATH, 'temp');
const ARCHIVE_DONE_PATH = path.join(ARCHIVE_BASE_PATH, 'done');

// Ensure archive directories exist
function ensureArchiveDirs() {
    [ARCHIVE_BASE_PATH, ARCHIVE_TEMP_PATH, ARCHIVE_DONE_PATH].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// Audit actions for archive
const ARCHIVE_AUDIT_ACTIONS = {
    ARCHIVED: 'ARCHIVE_ARCHIVED',
    RESTORED: 'ARCHIVE_RESTORED',
    SOFT_DELETED: 'ARCHIVE_SOFT_DELETED',
    HARD_DELETED: 'ARCHIVE_HARD_DELETED',
    UNDELETED: 'ARCHIVE_UNDELETED'
};

/**
 * Initialize archive module
 */
function init() {
    ensureArchiveDirs();
    console.log('Archive module initialized');
}

/**
 * Archive an attachment
 */
function archive(attachmentId, options = {}) {
    const { dryRun = false, archivedBy = 'system' } = options;
    const db = getDb();

    const attachment = getAttachmentById(attachmentId);
    if (!attachment) {
        throw new Error('Attachment not found');
    }

    if (attachment.status === 'ARCHIVED') {
        throw new Error('Attachment is already archived');
    }

    // Check for legal hold protection
    if (isProtected(attachmentId)) {
        throw new Error('Attachment is under legal hold and cannot be archived');
    }

    const archiveId = generateUUID();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveFilename = `archive-${attachmentId}-${timestamp}.tar.gz`;
    const archivePath = path.join(ARCHIVE_DONE_PATH, archiveFilename);

    // Calculate checksum of original file
    let checksum = null;
    if (fs.existsSync(attachment.storage_uri)) {
        const fileBuffer = fs.readFileSync(attachment.storage_uri);
        checksum = 'sha256:' + crypto.createHash('sha256').update(fileBuffer).digest('hex');
    }

    const fileSize = fs.existsSync(attachment.storage_uri)
        ? fs.statSync(attachment.storage_uri).size
        : 0;

    if (dryRun) {
        return {
            id: archiveId,
            attachment_id: attachmentId,
            action: 'archive',
            would_create: true,
            archive_path: archivePath,
            file_size: fileSize
        };
    }

    // Create tarball of attachment files
    const tempDir = path.join(ARCHIVE_TEMP_PATH, archiveId);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
        // Copy attachment file to temp
        if (fs.existsSync(attachment.storage_uri)) {
            const destPath = path.join(tempDir, attachment.canonical_filename || attachmentId);
            fs.copyFileSync(attachment.storage_uri, destPath);
        }

        // Write metadata file
        const metadata = {
            original_attachment_id: attachmentId,
            original_filename: attachment.original_filename,
            canonical_filename: attachment.canonical_filename,
            content_hash: attachment.content_hash,
            file_type: attachment.file_type,
            file_size: fileSize,
            checksum,
            archived_at: timestamp,
            archived_by: archivedBy,
            original_created_at: attachment.created_at,
            job_ref: attachment.job_ref,
            vehicle_reg: attachment.vehicle_reg,
            metadata: attachment.metadata
        };
        fs.writeFileSync(path.join(tempDir, '_metadata.json'), JSON.stringify(metadata, null, 2));

        // Create tarball (using simple approach - could use archiver for more features)
        const { execSync } = require('child_process');
        execSync(`cd "${tempDir}" && tar -czf "${archivePath}" .`, { encoding: 'utf-8' });

        // Update attachment status
        db.prepare("UPDATE attachments SET status = 'ARCHIVED' WHERE id = ?").run(attachmentId);

        // Create archive record
        db.prepare(`
            INSERT INTO archived_attachments (id, original_attachment_id, archive_path, archive_size, checksum, archived_at, archived_by, metadata, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ARCHIVED')
        `).run(
            archiveId,
            attachmentId,
            archivePath,
            fs.statSync(archivePath).size,
            checksum,
            timestamp,
            archivedBy,
            JSON.stringify(metadata)
        );

        // Log to audit
        logArchiveAction(archiveId, attachmentId, ARCHIVE_AUDIT_ACTIONS.ARCHIVED, {
            archive_path: archivePath,
            file_size: fileSize,
            archived_by: archivedBy
        });

        // Clean up temp directory
        fs.rmSync(tempDir, { recursive: true, force: true });

        return {
            id: archiveId,
            attachment_id: attachmentId,
            archive_path: archivePath,
            file_size: fs.statSync(archivePath).size,
            archived_at: timestamp
        };
    } catch (error) {
        // Clean up on error
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        throw error;
    }
}

/**
 * Restore an attachment from archive
 */
function restore(archiveId, options = {}) {
    const { dryRun = false, restoredBy = 'system' } = options;
    const db = getDb();

    const archiveRecord = db.prepare('SELECT * FROM archived_attachments WHERE id = ?').get(archiveId);
    if (!archiveRecord) {
        throw new Error('Archive record not found');
    }

    if (archiveRecord.status !== 'ARCHIVED') {
        throw new Error('Archive is not in ARCHIVED status');
    }

    if (!fs.existsSync(archiveRecord.archive_path)) {
        throw new Error('Archive file not found on disk');
    }

    const restoreId = generateUUID();
    const timestamp = new Date().toISOString();

    if (dryRun) {
        return {
            id: archiveId,
            action: 'restore',
            would_restore: true,
            original_attachment_id: archiveRecord.original_attachment_id
        };
    }

    // Extract to temp location
    const tempDir = path.join(ARCHIVE_TEMP_PATH, `restore-${archiveId}-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
        const { execSync } = require('child_process');
        execSync(`tar -xzf "${archiveRecord.archive_path}" -C "${tempDir}"`, { encoding: 'utf-8' });

        // Read metadata
        let metadata = {};
        const metadataPath = path.join(tempDir, '_metadata.json');
        if (fs.existsSync(metadataPath)) {
            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        }

        // Find the attachment file
        const files = fs.readdirSync(tempDir).filter(f => f !== '_metadata.json');
        if (files.length === 0) {
            throw new Error('No files found in archive');
        }

        const originalFile = files[0];
        const originalPath = path.join(tempDir, originalFile);

        // Generate new storage path for restored file
        const ext = path.extname(originalFile);
        const newFilename = `RESTORED-${Date.now()}${ext}`;
        const STORAGE_BASE = process.env.STORAGE_BASE_PATH || '/data/whatsapp-pod-pods';
        const restorePath = path.join(STORAGE_BASE, 'RESTORED', newFilename);
        fs.mkdirSync(path.dirname(restorePath), { recursive: true });
        fs.copyFileSync(originalPath, restorePath);

        // Create new attachment record
        const newAttachmentId = generateUUID();
        db.prepare(`
            INSERT INTO attachments (id, message_id, content_hash, file_type, file_size, original_filename, storage_uri, canonical_filename, status, job_ref, vehicle_reg, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            newAttachmentId,
            null, // message_id not restored
            metadata.content_hash || crypto.randomUUID(),
            metadata.file_type || 'application/octet-stream',
            metadata.file_size,
            metadata.original_filename || originalFile,
            restorePath,
            newFilename,
            'RESTORED',
            metadata.job_ref || null,
            metadata.vehicle_reg || null,
            JSON.stringify({ ...metadata.metadata, restored_from_archive: archiveId, restored_at: timestamp })
        );

        // Update archive record
        db.prepare(`
            UPDATE archived_attachments
            SET status = 'RESTORED', restore_path = ?, restored_at = ?, restored_by = ?
            WHERE id = ?
        `).run(restorePath, timestamp, restoredBy, archiveId);

        // Log to audit
        logArchiveAction(archiveId, newAttachmentId, ARCHIVE_AUDIT_ACTIONS.RESTORED, {
            restore_path: restorePath,
            original_archive: archiveRecord.original_attachment_id,
            restored_by: restoredBy
        });

        // Clean up temp
        fs.rmSync(tempDir, { recursive: true, force: true });

        return {
            id: archiveId,
            restored_attachment_id: newAttachmentId,
            restore_path: restorePath,
            restored_at: timestamp,
            restored_by: restoredBy
        };
    } catch (error) {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        throw error;
    }
}

/**
 * Soft delete an attachment (marks as PENDING_DELETE)
 */
function softDelete(attachmentId, options = {}) {
    const { deletedBy = 'system', reason = null } = options;
    const db = getDb();

    const attachment = getAttachmentById(attachmentId);
    if (!attachment) {
        throw new Error('Attachment not found');
    }

    if (['DELETED', 'PENDING_DELETE'].includes(attachment.status)) {
        throw new Error('Attachment is already deleted or pending deletion');
    }

    // Check for legal hold
    if (isProtected(attachmentId)) {
        throw new Error('Attachment is under legal hold and cannot be deleted');
    }

    const timestamp = new Date().toISOString();

    db.prepare(`
        UPDATE attachments
        SET status = 'PENDING_DELETE', metadata = ?
        WHERE id = ?
    `).run(
        JSON.stringify({ ...attachment.metadata, soft_deleted_at: timestamp, soft_deleted_by: deletedBy, delete_reason: reason }),
        attachmentId
    );

    // Log to audit
    logArchiveAction(null, attachmentId, ARCHIVE_AUDIT_ACTIONS.SOFT_DELETED, {
        deleted_by: deletedBy,
        reason,
        grace_period_applies: true
    });

    return {
        id: attachmentId,
        status: 'PENDING_DELETE',
        deleted_at: timestamp,
        deleted_by: deletedBy
    };
}

/**
 * Undelete a soft-deleted attachment
 */
function undelete(attachmentId, options = {}) {
    const { undeletedBy = 'system' } = options;
    const db = getDb();

    const attachment = getAttachmentById(attachmentId);
    if (!attachment) {
        throw new Error('Attachment not found');
    }

    if (attachment.status !== 'PENDING_DELETE') {
        throw new Error('Attachment is not pending deletion');
    }

    const timestamp = new Date().toISOString();

    // Restore original status from metadata
    const originalStatus = attachment.metadata?.original_status || 'REVIEW';

    db.prepare(`
        UPDATE attachments
        SET status = ?, metadata = ?
        WHERE id = ?
    `).run(
        originalStatus,
        JSON.stringify({ ...attachment.metadata, undeleted_at: timestamp, undeleted_by: undeletedBy }),
        attachmentId
    );

    // Log to audit
    logArchiveAction(null, attachmentId, ARCHIVE_AUDIT_ACTIONS.UNDELETED, {
        undeleted_by: undeletedBy
    });

    return {
        id: attachmentId,
        status: originalStatus,
        undeleted_at: timestamp,
        undeleted_by: undeletedBy
    };
}

/**
 * Hard delete an attachment (permanent)
 */
function hardDelete(attachmentId, options = {}) {
    const { deletedBy = 'system', reason = null, removeFiles = true } = options;
    const db = getDb();

    const attachment = getAttachmentById(attachmentId);
    if (!attachment) {
        throw new Error('Attachment not found');
    }

    if (isProtected(attachmentId)) {
        throw new Error('Attachment is under legal hold and cannot be deleted');
    }

    const timestamp = new Date().toISOString();

    // Update status to DELETED
    db.prepare(`
        UPDATE attachments
        SET status = 'DELETED', metadata = ?
        WHERE id = ?
    `).run(
        JSON.stringify({ ...attachment.metadata, hard_deleted_at: timestamp, hard_deleted_by: deletedBy, delete_reason: reason }),
        attachmentId
    );

    // Optionally remove files from storage
    if (removeFiles && fs.existsSync(attachment.storage_uri)) {
        try {
            fs.unlinkSync(attachment.storage_uri);
        } catch (err) {
            console.error('Failed to remove file:', err.message);
        }
    }

    // Log to audit
    logArchiveAction(null, attachmentId, ARCHIVE_AUDIT_ACTIONS.HARD_DELETED, {
        deleted_by: deletedBy,
        reason,
        files_removed: removeFiles
    });

    return {
        id: attachmentId,
        status: 'DELETED',
        deleted_at: timestamp,
        deleted_by: deletedBy
    };
}

/**
 * List archived attachments
 */
function list(options = {}) {
    const { limit = 50, offset = 0, status = null } = options;
    const db = getDb();

    let query = 'SELECT * FROM archived_attachments';
    const params = [];

    if (status) {
        query += ' WHERE status = ?';
        params.push(status);
    }

    query += ' ORDER BY archived_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(query).all(...params).map(row => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
}

/**
 * Get archive statistics
 */
function getStats() {
    const db = getDb();

    const archived = db.prepare("SELECT COUNT(*) as count FROM archived_attachments WHERE status = 'ARCHIVED'").get().count;
    const restored = db.prepare("SELECT COUNT(*) as count FROM archived_attachments WHERE status = 'RESTORED'").get().count;

    // Calculate total archive size
    const sizeResult = db.prepare("SELECT SUM(archive_size) as total_size FROM archived_attachments WHERE status = 'ARCHIVED'").get();
    const totalSize = sizeResult?.total_size || 0;

    // Get pending delete count
    const pendingDelete = db.prepare("SELECT COUNT(*) as count FROM attachments WHERE status = 'PENDING_DELETE'").get().count;

    // Get deleted count
    const deleted = db.prepare("SELECT COUNT(*) as count FROM attachments WHERE status = 'DELETED'").get().count;

    return {
        archived_count: archived,
        restored_count: restored,
        pending_delete_count: pendingDelete,
        deleted_count: deleted,
        total_archive_size_bytes: totalSize,
        total_archive_size_mb: Math.round(totalSize / (1024 * 1024) * 100) / 100
    };
}

/**
 * Find attachments eligible for archive
 */
function findToArchive(options = {}) {
    const { limit = 100 } = options;
    const db = getDb();

    // Find attachments past retention threshold, not on hold
    const stmt = db.prepare(`
        SELECT a.*, m.sender_id
        FROM attachments a
        JOIN messages m ON a.message_id = m.id
        WHERE a.status NOT IN ('ARCHIVED', 'DELETED', 'PENDING_DELETE')
        AND a.created_at < datetime('now', '-365 days')
        AND NOT EXISTS (
            SELECT 1 FROM legal_holds lh
            WHERE lh.attachment_id = a.id
            AND lh.status = 'ACTIVE'
            AND (lh.expires_at IS NULL OR lh.expires_at > datetime('now'))
        )
        ORDER BY a.created_at ASC
        LIMIT ?
    `);

    return stmt.all(limit);
}

/**
 * Find attachments eligible for hard delete
 */
function findToDelete(options = {}) {
    const { limit = 100 } = options;
    const db = getDb();

    // Find attachments past grace period, not on hold
    const stmt = db.prepare(`
        SELECT a.*, m.sender_id
        FROM attachments a
        JOIN messages m ON a.message_id = m.id
        WHERE a.status = 'PENDING_DELETE'
        AND a.created_at < datetime('now', '-395 days')  // 365 + 30 grace
        AND NOT EXISTS (
            SELECT 1 FROM legal_holds lh
            WHERE lh.attachment_id = a.id
            AND lh.status = 'ACTIVE'
            AND (lh.expires_at IS NULL OR lh.expires_at > datetime('now'))
        )
        ORDER BY a.created_at ASC
        LIMIT ?
    `);

    return stmt.all(limit);
}

/**
 * Log archive action to audit
 */
function logArchiveAction(archiveId, attachmentId, action, details = {}) {
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
        JSON.stringify({ archive_id: archiveId, ...details })
    );

    return id;
}

module.exports = {
    init,
    archive,
    restore,
    softDelete,
    undelete,
    hardDelete,
    list,
    getStats,
    findToArchive,
    findToDelete,
    ARCHIVE_AUDIT_ACTIONS
};
