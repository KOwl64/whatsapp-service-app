const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SQLITE_DB_PATH || './pod.db';
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

function init() {
    // Messages table - stores incoming WhatsApp messages
    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            source TEXT DEFAULT 'whatsapp',
            chat_id TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            received_at TEXT NOT NULL,
            raw_payload_ref TEXT,
            status TEXT DEFAULT 'PENDING',
            correlation_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            metadata TEXT
        )
    `);

    // Attachments table - stores POD file metadata
    db.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            content_hash TEXT UNIQUE,
            file_type TEXT,
            file_size INTEGER,
            original_filename TEXT,
            storage_uri TEXT NOT NULL,
            canonical_filename TEXT,
            status TEXT DEFAULT 'REVIEW',
            job_ref TEXT,
            vehicle_reg TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            metadata TEXT,
            FOREIGN KEY (message_id) REFERENCES messages(id)
        )
    `);

    // Audit logs table - immutable audit trail
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            attachment_id TEXT,
            message_id TEXT,
            action TEXT NOT NULL,
            actor TEXT NOT NULL,
            timestamp TEXT DEFAULT (datetime('now')),
            details TEXT,
            correlation_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Create indexes for common queries
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at DESC);
        CREATE INDEX IF NOT EXISTS idx_attachments_status ON attachments(status);
        CREATE INDEX IF NOT EXISTS idx_attachments_content_hash ON attachments(content_hash);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id ON audit_logs(correlation_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_attachment_id ON audit_logs(attachment_id);
    `);

    // Email queue table - stores emails pending sending
    db.exec(`
        CREATE TABLE IF NOT EXISTS email_queue (
            id TEXT PRIMARY KEY,
            attachment_id TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING',
            recipients_to TEXT,
            recipients_cc TEXT,
            recipients_bcc TEXT,
            subject TEXT,
            body TEXT,
            attachment_path TEXT,
            attachment_name TEXT,
            attempts INTEGER DEFAULT 0,
            last_attempt TEXT,
            next_retry TEXT,
            sent_at TEXT,
            error TEXT,
            message_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (attachment_id) REFERENCES attachments(id)
        )
    `);

    // Delivery log table - tracks email events
    db.exec(`
        CREATE TABLE IF NOT EXISTS delivery_log (
            id TEXT PRIMARY KEY,
            email_queue_id TEXT,
            attachment_id TEXT,
            event TEXT NOT NULL,
            timestamp TEXT DEFAULT (datetime('now')),
            details TEXT,
            FOREIGN KEY (email_queue_id) REFERENCES email_queue(id),
            FOREIGN KEY (attachment_id) REFERENCES attachments(id)
        )
    `);

    // Email queue indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status);
        CREATE INDEX IF NOT EXISTS idx_email_queue_next_retry ON email_queue(next_retry);
        CREATE INDEX IF NOT EXISTS idx_email_queue_attachment_id ON email_queue(attachment_id);
        CREATE INDEX IF NOT EXISTS idx_delivery_log_email_queue_id ON delivery_log(email_queue_id);
    `);

    // Legal holds table - prevents deletion of protected items
    db.exec(`
        CREATE TABLE IF NOT EXISTS legal_holds (
            id TEXT PRIMARY KEY,
            attachment_id TEXT NOT NULL,
            status TEXT DEFAULT 'ACTIVE',
            reason TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT,
            released_by TEXT,
            released_at TEXT,
            release_reason TEXT,
            notes TEXT,
            FOREIGN KEY (attachment_id) REFERENCES attachments(id)
        )
    `);

    // Legal holds indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_legal_holds_attachment_id ON legal_holds(attachment_id);
        CREATE INDEX IF NOT EXISTS idx_legal_holds_status ON legal_holds(status);
        CREATE INDEX IF NOT EXISTS idx_legal_holds_expires_at ON legal_holds(expires_at);
    `);

    // Exports table - tracks export records for audit (Phase 3 prep)
    db.exec(`
        CREATE TABLE IF NOT EXISTS exports (
            id TEXT PRIMARY KEY,
            attachment_id TEXT NOT NULL,
            message_id TEXT,
            export_type TEXT DEFAULT 'MANUAL',
            status TEXT DEFAULT 'PENDING',
            recipients TEXT,
            subject TEXT,
            body TEXT,
            attachments_ref TEXT,
            exported_at TEXT,
            delivered_at TEXT,
            error TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (attachment_id) REFERENCES attachments(id)
        )
    `);

    // Exports indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exports_status ON exports(status);
        CREATE INDEX IF NOT EXISTS idx_exports_attachment_id ON exports(attachment_id);
        CREATE INDEX IF NOT EXISTS idx_exports_created_at ON exports(created_at DESC);
    `);

    // Archived attachments table - stores archived POD files
    db.exec(`
        CREATE TABLE IF NOT EXISTS archived_attachments (
            id TEXT PRIMARY KEY,
            original_attachment_id TEXT NOT NULL,
            archive_path TEXT NOT NULL,
            archive_size INTEGER,
            checksum TEXT,
            archived_at TEXT DEFAULT (datetime('now')),
            archived_by TEXT NOT NULL,
            customer_id TEXT,
            metadata TEXT,
            restore_path TEXT,
            restored_at TEXT,
            restored_by TEXT,
            status TEXT DEFAULT 'ARCHIVED',
            FOREIGN KEY (original_attachment_id) REFERENCES attachments(id)
        )
    `);

    // Archived attachments indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_archived_original_id ON archived_attachments(original_attachment_id);
        CREATE INDEX IF NOT EXISTS idx_archived_status ON archived_attachments(status);
        CREATE INDEX IF NOT EXISTS idx_archived_archived_at ON archived_attachments(archived_at DESC);
    `);

    // Evidence bundles table - stores compliance export bundles
    db.exec(`
        CREATE TABLE IF NOT EXISTS evidence_bundles (
            id TEXT PRIMARY KEY,
            bundle_id TEXT UNIQUE NOT NULL,
            reason TEXT NOT NULL,
            requested_by TEXT NOT NULL,
            attachment_ids TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING',
            archive_path TEXT,
            file_size INTEGER,
            checksum TEXT,
            password TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT,
            downloaded_at TEXT,
            download_count INTEGER DEFAULT 0,
            error TEXT
        )
    `);

    // Evidence bundles indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_evidence_bundle_id ON evidence_bundles(bundle_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_status ON evidence_bundles(status);
        CREATE INDEX IF NOT EXISTS idx_evidence_created_at ON evidence_bundles(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_evidence_expires_at ON evidence_bundles(expires_at);
    `);

    console.log(`SQLite DB initialized: ${DB_PATH}`);
}

function getDb() {
    return db;
}

module.exports = { init, getDb };
