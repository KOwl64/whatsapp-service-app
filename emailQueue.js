/**
 * Email Queue Processor
 * Processes pending emails with retry logic and exponential backoff
 */

const { getDb, init: initDb } = require('./db');
const email = require('./email');
const audit = require('./audit');
const crypto = require('crypto');

// Configuration
const CONFIG = {
    pollInterval: parseInt(process.env.EMAIL_POLL_INTERVAL) || 30000, // 30 seconds
    maxConcurrent: parseInt(process.env.EMAIL_MAX_CONCURRENT) || 5,
    maxRetries: parseInt(process.env.EMAIL_MAX_RETRIES) || 5,
    batchSize: parseInt(process.env.EMAIL_BATCH_SIZE) || 10,
    retryDelays: [
        5 * 60 * 1000,      // 5 minutes
        30 * 60 * 1000,     // 30 minutes
        2 * 60 * 60 * 1000, // 2 hours
        24 * 60 * 60 * 1000 // 24 hours
    ]
};

// Processor state
let processorInterval = null;
let isProcessing = false;
let processedCount = 0;
let failedCount = 0;

/**
 * Generate UUID
 */
function generateUUID() {
    return crypto.randomUUID();
}

/**
 * Initialize the email queue processor
 */
async function init() {
    console.log('[EmailQueue] Initializing processor...');
    initDb();
    await email.init();
    console.log('[EmailQueue] Processor initialized');
}

/**
 * Start the background processor
 */
function startProcessor() {
    if (processorInterval) {
        console.log('[EmailQueue] Processor already running');
        return;
    }

    console.log(`[EmailQueue] Starting processor (poll interval: ${CONFIG.pollInterval}ms)`);

    // Process immediately, then on interval
    processQueue().catch(err => console.error('[EmailQueue] Initial process error:', err.message));

    processorInterval = setInterval(async () => {
        try {
            await processQueue();
        } catch (error) {
            console.error('[EmailQueue] Process error:', error.message);
        }
    }, CONFIG.pollInterval);
}

/**
 * Stop the background processor
 */
function stopProcessor() {
    if (processorInterval) {
        clearInterval(processorInterval);
        processorInterval = null;
        console.log('[EmailQueue] Processor stopped');
    }
}

/**
 * Get the next retry time based on attempt count
 */
function getNextRetryTime(attemptCount) {
    const delayIndex = Math.min(attemptCount - 1, CONFIG.retryDelays.length - 1);
    const delay = CONFIG.retryDelays[delayIndex] || CONFIG.retryDelays[CONFIG.retryDelays.length - 1];
    return new Date(Date.now() + delay).toISOString();
}

/**
 * Check if email is ready for retry
 */
function isReadyForRetry(record) {
    if (!record.next_retry) return true;
    return new Date(record.next_retry) <= new Date();
}

/**
 * Queue an email for sending
 */
function queueEmail(data) {
    const db = getDb();
    const id = generateUUID();

    const stmt = db.prepare(`
        INSERT INTO email_queue (
            id, attachment_id, status, recipients_to, recipients_cc, recipients_bcc,
            subject, body, attachment_path, attachment_name, message_id,
            next_retry, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        id,
        data.attachmentId,
        'PENDING',
        data.to ? JSON.stringify(data.to) : null,
        data.cc ? JSON.stringify(data.cc) : null,
        data.bcc ? JSON.stringify(data.bcc) : null,
        data.subject || null,
        data.body || null,
        data.attachmentPath || null,
        data.attachmentName || null,
        data.messageId || null,
        new Date().toISOString(),
        new Date().toISOString()
    );

    console.log(`[EmailQueue] Queued email: ${id}`);
    return id;
}

/**
 * Queue email from OUT queue attachment
 */
function queueFromOutAttachment(attachment, recipients) {
    return queueEmail({
        attachmentId: attachment.id,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: email.generateSubject({ jobRef: attachment.job_ref, vehicleReg: attachment.vehicle_reg }),
        attachmentPath: attachment.storage_uri,
        attachmentName: attachment.canonical_filename,
        messageId: attachment.message_id
    });
}

/**
 * Get pending emails from database
 */
function getPendingEmails(limit = CONFIG.batchSize) {
    const db = getDb();

    const stmt = db.prepare(`
        SELECT * FROM email_queue
        WHERE status = 'PENDING'
        AND (next_retry IS NULL OR next_retry <= ?)
        ORDER BY created_at ASC
        LIMIT ?
    `);

    return stmt.all(new Date().toISOString(), limit);
}

/**
 * Get email by ID
 */
function getEmailById(id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM email_queue WHERE id = ?');
    return stmt.get(id);
}

/**
 * Update email status
 */
function updateEmailStatus(id, status, extraFields = {}) {
    const db = getDb();
    let setClause = 'status = ?';
    const params = [status];

    if (extraFields.error !== undefined) {
        setClause += ', error = ?';
        params.push(extraFields.error);
    }
    if (extraFields.attempts !== undefined) {
        setClause += ', attempts = ?';
        params.push(extraFields.attempts);
    }
    if (extraFields.nextRetry !== undefined) {
        setClause += ', next_retry = ?';
        params.push(extraFields.nextRetry);
    }
    if (extraFields.sentAt !== undefined) {
        setClause += ', sent_at = ?';
        params.push(extraFields.sentAt);
    }
    if (extraFields.lastAttempt !== undefined) {
        setClause += ', last_attempt = ?';
        params.push(extraFields.lastAttempt);
    }

    params.push(id);

    const stmt = db.prepare(`UPDATE email_queue SET ${setClause} WHERE id = ?`);
    return stmt.run(...params);
}

/**
 * Log delivery event
 */
function logDeliveryEvent(emailQueueId, attachmentId, event, details = {}) {
    const db = getDb();
    const id = generateUUID();

    const stmt = db.prepare(`
        INSERT INTO delivery_log (id, email_queue_id, attachment_id, event, details, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        id,
        emailQueueId,
        attachmentId,
        event,
        JSON.stringify(details),
        new Date().toISOString()
    );

    return id;
}

/**
 * Get delivery log for an email
 */
function getDeliveryLog(emailQueueId) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT * FROM delivery_log
        WHERE email_queue_id = ?
        ORDER BY timestamp ASC
    `);
    return stmt.all(emailQueueId).map(row => ({
        ...row,
        details: row.details ? JSON.parse(row.details) : null
    }));
}

/**
 * Retry a failed email
 */
function retryEmail(id) {
    const emailRecord = getEmailById(id);
    if (!emailRecord) return false;

    if (emailRecord.attempts >= CONFIG.maxRetries) {
        console.log(`[EmailQueue] Max retries reached for ${id}`);
        return false;
    }

    updateEmailStatus(id, 'PENDING', {
        error: null,
        nextRetry: null
    });

    console.log(`[EmailQueue] Retrying email: ${id} (attempt ${emailRecord.attempts + 1})`);
    return true;
}

/**
 * Cancel a queued email
 */
function cancelEmail(id) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM email_queue WHERE id = ? AND status = ?');
    const result = stmt.run(id, 'PENDING');
    return result.changes > 0;
}

/**
 * Process a single email
 */
async function processEmail(record) {
    console.log(`[EmailQueue] Processing: ${record.id}`);

    // Update to SENDING
    updateEmailStatus(record.id, 'SENDING', {
        lastAttempt: new Date().toISOString(),
        attempts: (record.attempts || 0) + 1
    });

    // Parse recipients
    const recipients = {
        to: record.recipients_to ? JSON.parse(record.recipients_to) : [],
        cc: record.recipients_cc ? JSON.parse(record.recipients_cc) : [],
        bcc: record.recipients_bcc ? JSON.parse(record.recipients_bcc) : []
    };

    try {
        const result = await email.sendPodEmail({
            to: recipients.to,
            cc: recipients.cc,
            bcc: recipients.bcc,
            subject: record.subject,
            body: record.body,
            attachmentPath: record.attachment_path,
            attachmentName: record.attachment_name,
            metadata: {
                jobRef: null, // Will be populated from attachment if needed
                vehicleReg: null
            }
        });

        // Mark as sent
        updateEmailStatus(record.id, 'SENT', {
            sentAt: new Date().toISOString()
        });

        // Log delivery event
        logDeliveryEvent(record.id, record.attachment_id, 'SENT', {
            messageId: result.messageId,
            recipients: recipients
        });

        // Audit log
        audit.log({
            action: 'EMAIL_SENT',
            attachmentId: record.attachment_id,
            details: {
                emailQueueId: record.id,
                messageId: result.messageId,
                recipients: recipients
            }
        });

        console.log(`[EmailQueue] Sent: ${record.id}`);
        processedCount++;

        return true;
    } catch (error) {
        console.error(`[EmailQueue] Failed: ${record.id} - ${error.message}`);

        const attempts = (record.attempts || 0) + 1;
        const isHardBounce = error.message.includes('Invalid') || error.message.includes('does not exist');

        if (attempts >= CONFIG.maxRetries || isHardBounce) {
            // Max retries or hard bounce - mark as failed
            const finalStatus = isHardBounce ? 'BOUNCED' : 'FAILED';
            updateEmailStatus(record.id, finalStatus, {
                error: error.message
            });

            logDeliveryEvent(record.id, record.attachment_id, finalStatus, {
                error: error.message,
                attempts
            });

            audit.log({
                action: isHardBounce ? 'EMAIL_BOUNCED' : 'EMAIL_FAILED',
                attachmentId: record.attachment_id,
                details: {
                    emailQueueId: record.id,
                    error: error.message,
                    attempts
                }
            });

            failedCount++;
        } else {
            // Schedule retry
            const nextRetry = getNextRetryTime(attempts);
            updateEmailStatus(record.id, 'PENDING', {
                error: error.message,
                attempts,
                nextRetry
            });

            logDeliveryEvent(record.id, record.attachment_id, 'RETRY_SCHEDULED', {
                error: error.message,
                attempts,
                nextRetry
            });
        }

        return false;
    }
}

/**
 * Process the email queue
 */
async function processQueue() {
    if (isProcessing) {
        console.log('[EmailQueue] Already processing, skipping');
        return { skipped: true };
    }

    isProcessing = true;

    try {
        const pendingEmails = getPendingEmails(CONFIG.batchSize);

        if (pendingEmails.length === 0) {
            return { processed: 0, pending: 0 };
        }

        console.log(`[EmailQueue] Processing ${pendingEmails.length} emails`);

        let processed = 0;
        let failed = 0;

        for (const record of pendingEmails) {
            const success = await processEmail(record);
            if (success) processed++;
            else failed++;
        }

        return { processed, failed, total: pendingEmails.length };
    } finally {
        isProcessing = false;
    }
}

/**
 * Get queue statistics
 */
function getQueueStats() {
    const db = getDb();

    const stats = db.prepare(`
        SELECT
            status,
            COUNT(*) as count
        FROM email_queue
        GROUP BY status
    `).all();

    const result = {
        PENDING: 0,
        SENDING: 0,
        SENT: 0,
        FAILED: 0,
        BOUNCED: 0,
        total: 0
    };

    for (const row of stats) {
        result[row.status] = row.count;
        result.total += row.count;
    }

    // Add processing stats
    result.processed = processedCount;
    result.failed = failedCount;
    result.running = !!processorInterval;

    return result;
}

/**
 * Get recent failed emails
 */
function getRecentFailures(limit = 20) {
    const db = getDb();

    const stmt = db.prepare(`
        SELECT * FROM email_queue
        WHERE status IN ('FAILED', 'BOUNCED')
        ORDER BY last_attempt DESC
        LIMIT ?
    `);

    return stmt.all(limit).map(row => ({
        ...row,
        recipients_to: row.recipients_to ? JSON.parse(row.recipients_to) : [],
        recipients_cc: row.recipients_cc ? JSON.parse(row.recipients_cc) : []
    }));
}

/**
 * Clear old processed emails
 */
function clearOldEmails(daysOld = 30) {
    const db = getDb();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    const stmt = db.prepare(`
        DELETE FROM email_queue
        WHERE status = 'SENT'
        AND sent_at < ?
    `);

    const result = stmt.run(cutoff.toISOString());
    console.log(`[EmailQueue] Cleared ${result.changes} old sent emails`);

    return result.changes;
}

/**
 * Get processor status
 */
function getProcessorStatus() {
    return {
        running: !!processorInterval,
        pollInterval: CONFIG.pollInterval,
        maxConcurrent: CONFIG.maxConcurrent,
        maxRetries: CONFIG.maxRetries,
        batchSize: CONFIG.batchSize,
        processed: processedCount,
        failed: failedCount
    };
}

module.exports = {
    init,
    startProcessor,
    stopProcessor,
    queueEmail,
    queueFromOutAttachment,
    getEmailById,
    getPendingEmails,
    updateEmailStatus,
    logDeliveryEvent,
    getDeliveryLog,
    retryEmail,
    cancelEmail,
    processQueue,
    getQueueStats,
    getRecentFailures,
    clearOldEmails,
    getProcessorStatus
};
