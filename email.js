/**
 * Email Service Module
 * Sends POD emails using nodemailer with connection pooling
 */

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Email configuration from environment or config file
const CONFIG = {
    // SMTP settings
    host: process.env.SMTP_HOST || 'smtp.example.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || ''
    },
    // TLS/SSL settings
    tls: {
        rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false'
    },
    // From address
    from: process.env.EMAIL_FROM || 'Turners Distribution <noreply@turners-distribution.cloud>',
    replyTo: process.env.EMAIL_REPLY_TO || 'operations@turners-distribution.cloud',
    // Connection pool settings
    pool: true,
    maxConnections: parseInt(process.env.SMTP_MAX_CONNECTIONS) || 5,
    maxMessages: parseInt(process.env.SMTP_MAX_MESSAGES) || 100,
    rateDelta: parseInt(process.env.SMTP_RATE_DELTA) || 1000, // ms between messages
    rateLimit: parseInt(process.env.SMTP_RATE_LIMIT) || 10, // max messages per rateDelta
    // Message settings
    htmlTemplates: process.env.EMAIL_TEMPLATES_DIR || './email-templates',
    // Test mode (doesn't actually send)
    testMode: process.env.EMAIL_TEST_MODE === 'true'
};

// Transporter instance (lazy initialized)
let transporter = null;
let lastTestResult = null;

/**
 * Initialize or get the email transporter
 */
function getTransporter() {
    if (transporter) return transporter;

    if (CONFIG.testMode) {
        console.log('[Email] Running in TEST mode - emails will be logged only');
        transporter = {
            sendMail: async (mailOptions) => {
                console.log('[Email TEST] Would send to:', mailOptions.to);
                console.log('[Email TEST] Subject:', mailOptions.subject);
                return {
                    success: true,
                    messageId: 'test-' + crypto.randomUUID(),
                    testMode: true
                };
            }
        };
        return transporter;
    }

    if (!CONFIG.auth.user || !CONFIG.auth.pass) {
        console.warn('[Email] SMTP credentials not configured - using stub');
        return null;
    }

    transporter = nodemailer.createTransport({
        host: CONFIG.host,
        port: CONFIG.port,
        secure: CONFIG.secure,
        auth: CONFIG.auth,
        tls: CONFIG.tls,
        pool: CONFIG.pool,
        maxConnections: CONFIG.maxConnections,
        maxMessages: CONFIG.maxMessages,
        rateDelta: CONFIG.rateDelta,
        rateLimit: CONFIG.rateLimit
    });

    return transporter;
}

/**
 * Initialize the email module
 */
async function init() {
    console.log('[Email] Initializing email service...');

    if (!CONFIG.testMode && CONFIG.auth.user) {
        try {
            const transport = getTransporter();
            if (transport) {
                await transport.verify();
                console.log('[Email] SMTP connection verified');
            }
        } catch (error) {
            console.error('[Email] SMTP verification failed:', error.message);
        }
    }

    // Ensure templates directory exists
    if (!fs.existsSync(CONFIG.htmlTemplates)) {
        try {
            fs.mkdirSync(CONFIG.htmlTemplates, { recursive: true });
        } catch (e) {
            // Ignore if can't create
        }
    }

    console.log('[Email] Service initialized');
}

/**
 * Generate email subject for POD
 */
function generateSubject(opts) {
    const { jobRef, vehicleReg, date } = opts || {};

    if (jobRef) {
        return `POD for Job ${jobRef}${date ? ' - ' + date : ''}`;
    }
    if (vehicleReg) {
        return `POD for Vehicle ${vehicleReg}${date ? ' - ' + date : ''}`;
    }
    return 'Proof of Delivery';
}

/**
 * Generate HTML email body for POD
 */
function generateBody(opts) {
    const { jobRef, vehicleReg, deliveryDate, senderName, customMessage } = opts || {};

    let html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #25D366; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; }
        .details { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border: 1px solid #eee; }
        .label { font-weight: bold; color: #666; }
        .footer { text-align: center; padding: 20px; color: #888; font-size: 12px; }
        .image-box { text-align: center; padding: 20px; background: #fff; border: 2px dashed #ccc; margin: 15px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Proof of Delivery</h1>
        </div>
        <div class="content">
            <p>Please find attached the proof of delivery for your shipment.</p>
`;

    if (jobRef || vehicleReg) {
        html += `
            <div class="details">
                <p><span class="label">Job Reference:</span> ${jobRef || 'N/A'}</p>
                <p><span class="label">Vehicle:</span> ${vehicleReg || 'N/A'}</p>
                ${deliveryDate ? `<p><span class="label">Delivery Date:</span> ${deliveryDate}</p>` : ''}
            </div>
`;
    }

    if (customMessage) {
        html += `<p>${customMessage}</p>`;
    }

    html += `
            <div class="image-box">
                <p><strong>Attached:</strong> Proof of Delivery Image</p>
            </div>
        </div>
        <div class="footer">
            <p>This is an automated message from Turners Distribution</p>
            <p>For inquiries, please contact operations@turners-distribution.cloud</p>
        </div>
    </div>
</body>
</html>
`;

    return html;
}

/**
 * Generate plain text body for POD
 */
function generateTextBody(opts) {
    const { jobRef, vehicleReg, deliveryDate, customMessage } = opts || {};

    let text = `Proof of Delivery

Please find attached the proof of delivery for your shipment.

`;

    if (jobRef || vehicleReg) {
        text += `Details:\n`;
        if (jobRef) text += `  Job Reference: ${jobRef}\n`;
        if (vehicleReg) text += `  Vehicle: ${vehicleReg}\n`;
        if (deliveryDate) text += `  Delivery Date: ${deliveryDate}\n`;
        text += '\n';
    }

    if (customMessage) {
        text += `${customMessage}\n\n`;
    }

    text += `--\nThis is an automated message from Turners Distribution\nFor inquiries, please contact operations@turners-distribution.cloud`;

    return text;
}

/**
 * Send POD email to recipients
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email address(es)
 * @param {string|string[]} [options.cc] - CC recipients
 * @param {string|string[]} [options.bcc] - BCC recipients
 * @param {string} [options.subject] - Email subject (auto-generated if not provided)
 * @param {string} [options.body] - Custom message body
 * @param {string} options.attachmentPath - Path to POD file
 * @param {string} [options.attachmentName] - Display name for attachment
 * @param {Object} [options.metadata] - Additional metadata (jobRef, vehicleReg, etc.)
 * @returns {Promise<Object>} Send result
 */
async function sendPodEmail(options) {
    const {
        to,
        cc = [],
        bcc = [],
        subject,
        body,
        attachmentPath,
        attachmentName,
        metadata = {}
    } = options;

    // Normalize recipients
    const normalizeRecipients = (recipients) => {
        if (!recipients) return [];
        if (typeof recipients === 'string') {
            return recipients.split(',').map(e => e.trim()).filter(e => e);
        }
        return Array.isArray(recipients) ? recipients.filter(e => e) : [];
    };

    const toRecipients = normalizeRecipients(to);
    const ccRecipients = normalizeRecipients(cc);
    const bccRecipients = normalizeRecipients(bcc);

    if (toRecipients.length === 0) {
        throw new Error('At least one recipient is required');
    }

    // Generate subject if not provided
    const emailSubject = subject || generateSubject(metadata);
    const emailBody = body || '';

    // Prepare mail options
    const mailOptions = {
        from: CONFIG.from,
        to: toRecipients.join(', '),
        subject: emailSubject,
        replyTo: CONFIG.replyTo,
        text: generateTextBody({ ...metadata, customMessage: emailBody }),
        html: generateBody({ ...metadata, customMessage: emailBody }),
        attachments: []
    };

    if (ccRecipients.length > 0) {
        mailOptions.cc = ccRecipients.join(', ');
    }
    if (bccRecipients.length > 0) {
        mailOptions.bcc = bccRecipients.join(', ');
    }

    // Add attachment if provided
    if (attachmentPath && fs.existsSync(attachmentPath)) {
        mailOptions.attachments.push({
            filename: attachmentName || path.basename(attachmentPath),
            path: attachmentPath,
            contentType: getContentType(attachmentPath)
        });
    } else if (attachmentPath) {
        console.warn('[Email] Attachment path not found:', attachmentPath);
    }

    // Send email
    const transport = getTransporter();
    if (!transport) {
        console.log('[Email] No transporter available - simulating send');
        return {
            success: true,
            messageId: 'sim-' + crypto.randomUUID(),
            simulated: true,
            to: toRecipients,
            subject: emailSubject
        };
    }

    try {
        const result = await transport.sendMail(mailOptions);

        console.log(`[Email] Sent to ${toRecipients.length} recipient(s): ${emailSubject}`);

        return {
            success: true,
            messageId: result.messageId,
            to: toRecipients,
            subject: emailSubject
        };
    } catch (error) {
        console.error('[Email] Send failed:', error.message);
        throw error;
    }
}

/**
 * Send bulk POD emails
 * @param {Array} attachments - Array of attachment objects with email data
 * @returns {Promise<Object>} Results summary
 */
async function sendBulkPodEmails(attachments) {
    const results = {
        sent: 0,
        failed: 0,
        errors: []
    };

    for (const item of attachments) {
        try {
            await sendPodEmail(item);
            results.sent++;

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            results.failed++;
            results.errors.push({
                attachment: item.attachmentPath,
                error: error.message
            });
        }
    }

    return results;
}

/**
 * Get content type for file extension
 */
function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.pdf': 'application/pdf',
        '.tiff': 'image/tiff',
        '.webp': 'image/webp'
    };
    return types[ext] || 'application/octet-stream';
}

/**
 * Get email service status
 */
function getStatus() {
    return {
        configured: !!CONFIG.auth.user && !CONFIG.testMode,
        provider: CONFIG.testMode ? 'test' : CONFIG.host,
        from: CONFIG.from,
        testMode: CONFIG.testMode,
        lastTest: lastTestResult
    };
}

/**
 * Test email configuration
 */
async function testConnection() {
    const transport = getTransporter();

    if (!transport) {
        lastTestResult = {
            success: false,
            error: 'No transporter configured'
        };
        return lastTestResult;
    }

    try {
        await transport.verify();
        lastTestResult = {
            success: true,
            timestamp: new Date().toISOString()
        };
        return lastTestResult;
    } catch (error) {
        lastTestResult = {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        };
        return lastTestResult;
    }
}

/**
 * Close transporter connection
 */
async function close() {
    if (transporter) {
        try {
            await transporter.close();
            transporter = null;
            console.log('[Email] Transporter closed');
        } catch (error) {
            console.error('[Email] Error closing transporter:', error.message);
        }
    }
}

module.exports = {
    init,
    sendPodEmail,
    sendBulkPodEmails,
    generateSubject,
    generateBody,
    generateTextBody,
    getStatus,
    testConnection,
    close
};
