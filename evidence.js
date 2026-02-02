/**
 * Evidence Bundle Export Module
 *
 * Generates compliance bundles for legal/investigative purposes
 * with full audit trail and integrity verification.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./db');
const { getAttachmentById, getAuditTrail, generateUUID } = require('./models');
const { getAttachmentHolds, isProtected } = require('./legalHold');

// Export configuration
const EXPORT_BASE_PATH = process.env.EXPORT_BASE_PATH || '/data/whatsapp-exports';
const BUNDLE_EXPIRY_DAYS = parseInt(process.env.BUNDLE_EXPIRY_DAYS) || 90;

// Ensure export directories exist
function ensureExportDirs() {
    if (!fs.existsSync(EXPORT_BASE_PATH)) {
        fs.mkdirSync(EXPORT_BASE_PATH, { recursive: true });
    }
}

// Audit actions for evidence bundles
const EVIDENCE_AUDIT_ACTIONS = {
    BUNDLE_CREATED: 'EVIDENCE_BUNDLE_CREATED',
    BUNDLE_DOWNLOADED: 'EVIDENCE_BUNDLE_DOWNLOADED',
    BUNDLE_FAILED: 'EVIDENCE_BUNDLE_FAILED',
    BUNDLE_EXPIRED: 'EVIDENCE_BUNDLE_EXPIRED',
    BUNDLE_VERIFIED: 'EVIDENCE_BUNDLE_VERIFIED'
};

/**
 * Initialize evidence module
 */
function init() {
    ensureExportDirs();
    console.log('Evidence Bundle module initialized');
}

/**
 * Generate unique bundle ID
 */
function generateBundleId() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const sequence = crypto.randomBytes(2).toString('hex').substring(0, 4);
    return `ev-${year}${month}-${sequence}`;
}

/**
 * Create evidence bundle from attachment IDs
 */
async function createBundle(options = {}) {
    const {
        attachmentIds = [],
        dateFrom = null,
        dateTo = null,
        status = null,
        customerName = null,
        jobRefPattern = null,
        createdBy = 'system',
        reason = 'Compliance request',
        dryRun = false,
        password = null
    } = options;

    const db = getDb();

    // Build query for attachments based on filters
    let attachments = [];
    let queryParams = [];
    let whereClauses = ['a.status NOT IN (\'DELETED\', \'PENDING_DELETE\')'];

    if (attachmentIds.length > 0) {
        const placeholders = attachmentIds.map(() => '?').join(',');
        whereClauses.push(`a.id IN (${placeholders})`);
        queryParams.push(...attachmentIds);
    }

    if (dateFrom) {
        whereClauses.push('a.created_at >= ?');
        queryParams.push(dateFrom);
    }

    if (dateTo) {
        whereClauses.push('a.created_at <= ?');
        queryParams.push(dateTo);
    }

    if (status) {
        whereClauses.push('a.status = ?');
        queryParams.push(status);
    }

    if (jobRefPattern) {
        whereClauses.push('a.job_ref LIKE ?');
        queryParams.push(jobRefPattern);
    }

    const query = `
        SELECT a.*, m.sender_id, m.received_at as message_received_at
        FROM attachments a
        JOIN messages m ON a.message_id = m.id
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT 100
    `;

    attachments = db.prepare(query).all(...queryParams).map(row => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));

    if (attachments.length === 0) {
        throw new Error('No attachments found matching criteria');
    }

    if (attachments.length > 50) {
        throw new Error('Too many attachments (max 50). Please narrow your criteria.');
    }

    const bundleId = generateBundleId();
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + BUNDLE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const bundleRecord = {
        id: generateUUID(),
        bundle_id: bundleId,
        reason,
        requested_by: createdBy,
        attachment_ids: attachments.map(a => a.id),
        status: 'READY',
        created_at: timestamp,
        expires_at: expiresAt,
        download_count: 0
    };

    if (dryRun) {
        return {
            ...bundleRecord,
            action: 'create',
            would_create: true,
            attachment_count: attachments.length
        };
    }

    const tempDir = path.join(EXPORT_BASE_PATH, 'temp', bundleId);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
        // Create manifest
        const manifest = {
            bundle_id: bundleId,
            created_at: timestamp,
            created_by: createdBy,
            reason,
            expires_at: expiresAt,
            item_count: attachments.length,
            items: []
        };

        // Process each attachment
        for (const attachment of attachments) {
            const itemDir = path.join(tempDir, attachment.id);
            fs.mkdirSync(itemDir, { recursive: true });

            // Copy attachment file
            let checksum = null;
            if (fs.existsSync(attachment.storage_uri)) {
                const fileBuffer = fs.readFileSync(attachment.storage_uri);
                checksum = 'sha256:' + crypto.createHash('sha256').update(fileBuffer).digest('hex');
                const destPath = path.join(itemDir, attachment.canonical_filename || attachment.id);
                fs.copyFileSync(attachment.storage_uri, destPath);
            }

            // Get audit trail
            const auditTrail = getAuditTrail(attachment.id).map(entry => ({
                ...entry,
                details: entry.details || {}
            }));

            // Get legal hold status
            const holds = getAttachmentHolds(attachment.id);
            const onHold = holds.some(h => h.status === 'ACTIVE');
            const activeHolds = holds.filter(h => h.status === 'ACTIVE');

            // Add to manifest
            manifest.items.push({
                id: attachment.id,
                type: 'attachment',
                filename: attachment.original_filename || attachment.canonical_filename,
                checksum,
                received_at: attachment.created_at,
                status: attachment.status,
                job_ref: attachment.job_ref,
                vehicle_reg: attachment.vehicle_reg,
                legal_hold: onHold ? {
                    active: true,
                    holds: activeHolds.map(h => ({
                        id: h.id,
                        reason: h.reason,
                        expires_at: h.expires_at
                    }))
                } : { active: false },
                audit_trail_summary: {
                    total_entries: auditTrail.length,
                    actions: [...new Set(auditTrail.map(e => e.action))]
                }
            });

            // Write audit trail to file
            fs.writeFileSync(
                path.join(itemDir, '_audit.json'),
                JSON.stringify(auditTrail, null, 2)
            );
        }

        // Write manifest
        fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

        // Create bundle checksum
        const manifestBuffer = fs.readFileSync(path.join(tempDir, 'manifest.json'));
        const bundleChecksum = 'sha256:' + crypto.createHash('sha256').update(manifestBuffer).digest('hex');

        // Create tarball
        const bundlePath = path.join(EXPORT_BASE_PATH, `${bundleId}.tar.gz`);
        const { execSync } = require('child_process');
        execSync(`cd "${tempDir}" && tar -czf "${bundlePath}" .`, { encoding: 'utf-8' });

        // Get file size
        const fileSize = fs.statSync(bundlePath).size;

        // Save bundle record
        db.prepare(`
            INSERT INTO evidence_bundles (id, bundle_id, reason, requested_by, attachment_ids, status, archive_path, file_size, checksum, password, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            bundleRecord.id,
            bundleRecord.bundle_id,
            bundleRecord.reason,
            bundleRecord.requested_by,
            JSON.stringify(bundleRecord.attachment_ids),
            'READY',
            bundlePath,
            fileSize,
            bundleChecksum,
            password,
            bundleRecord.created_at,
            bundleRecord.expires_at
        );

        // Log to audit
        logEvidenceAction(bundleRecord.id, null, EVIDENCE_AUDIT_ACTIONS.BUNDLE_CREATED, {
            bundle_id: bundleId,
            created_by: createdBy,
            reason,
            attachment_count: attachments.length,
            file_size: fileSize
        });

        // Clean up temp
        fs.rmSync(tempDir, { recursive: true, force: true });

        return {
            id: bundleRecord.id,
            bundle_id: bundleId,
            reason,
            requested_by: createdBy,
            status: 'READY',
            archive_path: bundlePath,
            file_size: fileSize,
            checksum: bundleChecksum,
            created_at: timestamp,
            expires_at: expiresAt,
            download_count: 0
        };
    } catch (error) {
        // Clean up on error
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }

        // Log failure
        logEvidenceAction(bundleRecord.id, null, EVIDENCE_AUDIT_ACTIONS.BUNDLE_FAILED, {
            bundle_id: bundleId,
            error: error.message,
            created_by: createdBy
        });

        throw error;
    }
}

/**
 * Get evidence bundle by ID
 */
function getBundle(bundleId) {
    const db = getDb();

    const bundle = db.prepare('SELECT * FROM evidence_bundles WHERE bundle_id = ?').get(bundleId);
    if (!bundle) {
        return null;
    }

    return {
        ...bundle,
        attachment_ids: JSON.parse(bundle.attachment_ids),
        password_protected: !!bundle.password
    };
}

/**
 * List evidence bundles
 */
function listBundles(options = {}) {
    const { limit = 50, offset = 0, status = null, createdBy = null } = options;
    const db = getDb();

    let query = 'SELECT * FROM evidence_bundles';
    const params = [];
    const conditions = [];

    if (status) {
        conditions.push('status = ?');
        params.push(status);
    }

    if (createdBy) {
        conditions.push('requested_by = ?');
        params.push(createdBy);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(query).all(...params).map(bundle => ({
        ...bundle,
        attachment_ids: JSON.parse(bundle.attachment_ids),
        password_protected: !!bundle.password
    }));
}

/**
 * Verify bundle integrity
 */
function verifyBundle(bundleId) {
    const bundle = getBundle(bundleId);
    if (!bundle) {
        throw new Error('Bundle not found');
    }

    if (!fs.existsSync(bundle.archive_path)) {
        return {
            valid: false,
            error: 'Bundle file not found on disk'
        };
    }

    // Calculate checksum
    const fileBuffer = fs.readFileSync(bundle.archive_path);
    const calculatedChecksum = 'sha256:' + crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const isValid = calculatedChecksum === bundle.checksum;

    // Log verification
    logEvidenceAction(bundle.id, null, EVIDENCE_AUDIT_ACTIONS.BUNDLE_VERIFIED, {
        bundle_id: bundleId,
        valid: isValid,
        checksums_match: isValid,
        stored_checksum: bundle.checksum,
        calculated_checksum: calculatedChecksum
    });

    return {
        valid: isValid,
        stored_checksum: bundle.checksum,
        calculated_checksum: calculatedChecksum,
        file_size: bundle.file_size,
        expires_at: bundle.expires_at,
        is_expired: new Date(bundle.expires_at) < new Date()
    };
}

/**
 * Download bundle - record download and return path
 */
function recordDownload(bundleId, downloadedBy = 'api') {
    const db = getDb();

    const bundle = db.prepare('SELECT * FROM evidence_bundles WHERE bundle_id = ?').get(bundleId);
    if (!bundle) {
        throw new Error('Bundle not found');
    }

    const timestamp = new Date().toISOString();

    // Update download count
    db.prepare(`
        UPDATE evidence_bundles
        SET downloaded_at = ?, download_count = download_count + 1
        WHERE id = ?
    `).run(timestamp, bundle.id);

    // Log to audit
    logEvidenceAction(bundle.id, null, EVIDENCE_AUDIT_ACTIONS.BUNDLE_DOWNLOADED, {
        bundle_id: bundleId,
        downloaded_by: downloadedBy,
        download_count: bundle.download_count + 1
    });

    return {
        path: bundle.archive_path,
        filename: `evidence-${bundleId}.tar.gz`,
        checksum: bundle.checksum
    };
}

/**
 * Delete expired bundles
 */
function cleanupExpiredBundles() {
    const db = getDb();
    const now = new Date().toISOString();

    const expired = db.prepare(`
        SELECT * FROM evidence_bundles
        WHERE status = 'READY' AND expires_at < ?
    `).all(now);

    for (const bundle of expired) {
        // Remove file
        if (fs.existsSync(bundle.archive_path)) {
            fs.unlinkSync(bundle.archive_path);
        }

        // Update status
        db.prepare("UPDATE evidence_bundles SET status = 'EXPIRED' WHERE id = ?").run(bundle.id);

        // Log
        logEvidenceAction(bundle.id, null, EVIDENCE_AUDIT_ACTIONS.BUNDLE_EXPIRED, {
            bundle_id: bundle.bundle_id,
            expired_at: now,
            original_expires_at: bundle.expires_at
        });
    }

    return expired.length;
}

/**
 * Get evidence bundle statistics
 */
function getStats() {
    const db = getDb();

    const total = db.prepare('SELECT COUNT(*) as count FROM evidence_bundles').get().count;
    const ready = db.prepare("SELECT COUNT(*) as count FROM evidence_bundles WHERE status = 'READY'").get().count;
    const expired = db.prepare("SELECT COUNT(*) as count FROM evidence_bundles WHERE status = 'EXPIRED'").get().count;
    const totalDownloads = db.prepare('SELECT SUM(download_count) as total FROM evidence_bundles').get().total || 0;

    const sizeResult = db.prepare('SELECT SUM(file_size) as total_size FROM evidence_bundles WHERE status = \'READY\'').get();
    const totalSize = sizeResult?.total_size || 0;

    return {
        total_bundles: total,
        ready_bundles: ready,
        expired_bundles: expired,
        total_downloads: totalDownloads,
        total_size_bytes: totalSize,
        total_size_mb: Math.round(totalSize / (1024 * 1024) * 100) / 100
    };
}

/**
 * Log evidence action to audit
 */
function logEvidenceAction(bundleId, attachmentId, action, details = {}) {
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
        JSON.stringify({ bundle_id: bundleId, ...details })
    );

    return id;
}

module.exports = {
    init,
    createBundle,
    getBundle,
    listBundles,
    verifyBundle,
    recordDownload,
    cleanupExpiredBundles,
    getStats,
    EVIDENCE_AUDIT_ACTIONS,
    EXPORT_BASE_PATH
};
