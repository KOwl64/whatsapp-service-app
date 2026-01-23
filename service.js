const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Import POD pipeline modules
const { init: initDb } = require('./db');
const models = require('./models');
const normalise = require('./normalise');
const audit = require('./audit');
const classify = require('./classify');
const match = require('./match');
const autoRoute = require('./autoRoute');
const ocr = require('./ocr');
const extractor = require('./extractor');
const email = require('./email');
const emailQueue = require('./emailQueue');
const recipients = require('./recipients');
// Import Phase 4 modules
const retention = require('./retention');
const legalHold = require('./legalHold');
const archive = require('./archive');
const evidence = require('./evidence');
const scheduler = require('./scheduler');

// Import Phase 5 modules (Operations & Monitoring)
const health = require('./health');
const metrics = require('./metrics');
const alerts = require('./alerts');
const runbooks = require('./runbooks');

const app = express();
app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// WhatsApp Admin page
app.get('/whatsapp-admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'ops.html'));
});

let client;
let isReady = false;

// QR Code state for web display
let currentQRCode = null;

// Storage directories
const STORAGE_BASE = process.env.STORAGE_BASE_PATH || '/data/whatsapp-pod-pods';
const INBOX_DIR = path.join(STORAGE_BASE, 'INBOX');
const TEXT_DIR = path.join(STORAGE_BASE, 'TEXT_MESSAGES');
const TEMP_DIR = path.join(STORAGE_BASE, 'temp');

// Ensure directories exist
[INBOX_DIR, TEXT_DIR, TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Initialize POD pipeline
normalise.ensureStorageDirectories();
initDb();

function sanitizeFilename(name) {
    if (!name) return 'unknown';
    return name
        .replace(/\//g, '-')
        .replace(/\\/g, '-')
        .replace(/\.\./g, '')
        .replace(/[<>:"|?*]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function initWhatsApp() {
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        }
    });

    client.on('qr', async (qr) => {
        console.log('\n========================================');
        console.log('QR CODE - SCAN WITH WHATSAPP');
        console.log('========================================\n');
        qrcode.generate(qr, { small: true });

        // Store QR for web display
        try {
            const QRCode = require('qrcode');
            currentQRCode = await QRCode.toDataURL(qr);
            currentQRCode = currentQRCode.replace('data:image/png;base64,', '');
        } catch (err) {
            console.error('Error generating QR for web:', err.message);
        }
    });

    client.on('ready', () => {
        console.log('WhatsApp POD Service Ready!');
        isReady = true;
        currentQRCode = null; // Clear QR after successful auth
    });

    client.on('authenticated', () => {
        console.log('Authentication successful!');
    });

    client.on('message', async (message) => {
        const from = message.from;
        const chat = await message.getChat();
        const senderName = sanitizeFilename(chat.name || from);
        const receivedAt = new Date();
        const correlationId = audit.createNewCorrelationId();

        try {
            console.log(`Message from ${senderName} (${from})`);

            // Handle media (PODs)
            if (message.hasMedia) {
                await processMediaMessage(message, from, senderName, receivedAt, correlationId);
            }

            // Handle text message
            if (message.body) {
                await processTextMessage(message, from, senderName, receivedAt, correlationId);
            }

            audit.clearCorrelationId();
        } catch (error) {
            console.error('Error handling message:', error.message);
            audit.logFailed(null, error, { from, correlationId });
            audit.clearCorrelationId();
        }
    });

    client.on('disconnected', (reason) => {
        console.log('Client disconnected:', reason);
        isReady = false;
        // Auto-reconnect after 5 seconds
        setTimeout(() => {
            console.log('Attempting reconnection...');
            initWhatsApp();
        }, 5000);
    });

    client.initialize();
}

// ============================================
// Process media (POD images/documents)
// ============================================
async function processMediaMessage(message, from, senderName, receivedAt, correlationId) {
    try {
        const media = await message.downloadMedia();
        if (!media) {
            console.log('No media found in message');
            return;
        }

        // Create message record in DB
        const messageData = models.createMessage({
            chat_id: from,
            sender_id: from,
            received_at: receivedAt.toISOString(),
            status: 'RECEIVED',
            correlation_id: correlationId,
            metadata: {
                whatsappMessageId: message.id._serialized,
                senderName
            }
        });

        audit.logIngest(messageData.id, {
            sender: from,
            senderName,
            messageType: 'media',
            hasMedia: true
        });

        // Determine file type
        const mimeType = media.mimetype;
        const extension = mimeType.split('/')[1] || 'bin';
        const timestamp = Date.now();
        const tempFilename = `${timestamp}_${from}_${message.id._serialized}.${extension}`;
        const tempPath = path.join(TEMP_DIR, tempFilename);

        // Save temp file
        fs.writeFileSync(tempPath, media.data, 'base64');

        // Process file through POD pipeline
        const processed = normalise.validateAndProcessFile(tempPath, {
            receivedAt,
            mimeType,
            originalFilename: message._data?.filename || null
        });

        // Move to canonical storage location
        normalise.moveToStorage(tempPath, processed.storagePath);

        // Get image dimensions for classification
        let width, height;
        try {
            const dims = classify.getImageDimensions(processed.storagePath);
            width = dims.width;
            height = dims.height;
        } catch (e) {
            console.log('Could not get image dimensions:', e.message);
        }

        // Create attachment record first (with default REVIEW status)
        const attachmentData = models.createAttachment({
            message_id: messageData.id,
            content_hash: processed.contentHash,
            file_type: processed.fileType,
            file_size: processed.fileSize,
            original_filename: message._data?.filename || null,
            storage_uri: normalise.generateStorageUri(processed.storagePath),
            canonical_filename: processed.canonicalFilename,
            status: 'REVIEW',
            metadata: { mimeType }
        });

        audit.logNormalise(attachmentData.id, {
            canonicalFilename: processed.canonicalFilename,
            storagePath: processed.storagePath,
            contentHash: processed.contentHash,
            fileSize: processed.fileSize
        });

        // ============================================
        // Phase 2: Auto-classify, OCR, match, and route
        // ============================================

        // 1. Classify the attachment
        const classification = classify.classify({
            width,
            height,
            size: processed.fileSize,
            contentHash: processed.contentHash,
            fileType: processed.fileType
        });

        audit.logClassify(attachmentData.id, {
            isPod: classification.is_pod,
            confidence: classification.confidence,
            reasons: classification.reasons
        });

        console.log(`Classification: is_pod=${classification.is_pod}, confidence=${classification.confidence}`);

        // 2. If POD, run OCR and extract fields
        let ocrResult = null;
        let extractedFields = null;

        if (classification.is_pod) {
            // Run OCR asynchronously
            try {
                console.log('Running OCR...');
                ocrResult = await ocr.extractText(processed.storagePath);

                if (ocrResult.success) {
                    // Extract structured fields
                    extractedFields = extractor.fromText(ocrResult.text);

                    // Log OCR extraction
                    audit.log({
                        action: 'OCR_EXTRACTED',
                        attachmentId: attachmentData.id,
                        correlationId,
                        details: {
                            wordCount: ocrResult.wordCount,
                            confidence: ocrResult.confidence,
                            duration: ocrResult.duration,
                            fieldsFound: {
                                jobRefs: extractedFields.jobRefs.length,
                                vehicleRegs: extractedFields.vehicleRegs.length,
                                dates: extractedFields.dates.length,
                                phones: extractedFields.phones.length
                            }
                        }
                    });

                    console.log(`OCR: ${ocrResult.wordCount} words, quality: ${extractor.getQualityScore(extractedFields).percentage}%`);

                    // Log extracted fields
                    if (extractedFields.jobRefs.length > 0 || extractedFields.vehicleRegs.length > 0) {
                        audit.log({
                            action: 'FIELDS_EXTRACTED',
                            attachmentId: attachmentData.id,
                            correlationId,
                            details: {
                                jobRefs: extractedFields.jobRefs,
                                vehicleRegs: extractedFields.vehicleRegs,
                                dates: extractedFields.dates,
                                phones: extractedFields.phones,
                                quality: extractor.getQualityScore(extractedFields)
                            }
                        });
                    }
                }
            } catch (ocrError) {
                console.error('OCR error:', ocrError.message);
                audit.logFailed(attachmentData.id, ocrError, { phase: 'OCR' });
            }

            // 3. Match with job using extracted fields
            let jobMatch = null;
            const senderPhone = from.replace('@c.us', '').replace('@g.us', '');

            if (extractedFields && (extractedFields.jobRefs.length > 0 || extractedFields.vehicleRegs.length > 0)) {
                // Try matching with extracted fields first
                const bestField = extractor.getBestForMatching(extractedFields);
                console.log(`Matching with extracted ${bestField.type}: ${bestField.value}`);

                if (bestField.type === 'jobRefs') {
                    jobMatch = await match.findByJobRef(bestField.value);
                } else if (bestField.type === 'vehicleRegs') {
                    jobMatch = await match.findByVehicleReg(bestField.value);
                } else if (bestField.type === 'phones') {
                    jobMatch = await match.findByPhone(bestField.value);
                }
            }

            // Fallback to sender-based matching
            if (!jobMatch || !jobMatch.job) {
                jobMatch = await match.findBestMatch({ sender: senderPhone });
            }

            if (jobMatch && jobMatch.job) {
                audit.logMatch(attachmentData.id, {
                    jobId: jobMatch.job.id,
                    jobRef: jobMatch.job.ref,
                    confidence: jobMatch.confidence,
                    matchType: jobMatch.matchType,
                    matchedFields: jobMatch.matchedFields,
                    source: extractedFields?.jobRefs?.length > 0 ? 'OCR' : 'SENDER'
                });
                console.log(`Job match: ${jobMatch.job.ref}, confidence=${jobMatch.confidence}, type=${jobMatch.matchType}`);
            } else {
                audit.logMatch(attachmentData.id, {
                    jobId: null,
                    jobRef: null,
                    confidence: 0,
                    matchType: 'NO_MATCH',
                    matchedFields: [],
                    source: 'NONE'
                });
            }

            // 4. Auto-route based on classification and match
            const routeDecision = autoRoute.route({
                classification,
                match: jobMatch,
                sender: from
            });

            // Update attachment status with routing decision and OCR data
            models.updateAttachmentStatus(attachmentData.id, routeDecision.routeTo, {
                classificationConfidence: classification.confidence,
                matchConfidence: jobMatch?.confidence || 0,
                matchType: jobMatch?.matchType || null,
                jobRef: jobMatch?.job?.ref || null,
                routingDecision: routeDecision.decisionType,
                routingReason: routeDecision.details?.reason,
                // Include OCR data
                ocrText: ocrResult?.success ? ocrResult.text.substring(0, 500) : null,
                ocrConfidence: ocrResult?.confidence || 0,
                extractedJobRefs: extractedFields?.jobRefs || [],
                extractedVehicleRegs: extractedFields?.vehicleRegs || []
            });

            audit.logRoute(attachmentData.id, routeDecision.routeTo, {
                decisionType: routeDecision.decisionType,
                confidence: routeDecision.confidence,
                reason: routeDecision.details?.reason,
                classification: classification,
                match: jobMatch,
                ocr: ocrResult?.success ? { wordCount: ocrResult.wordCount, quality: extractor.getQualityScore(extractedFields) } : null
            });

            console.log(`Routed: ${routeDecision.routeTo} (${routeDecision.decisionType}, confidence=${routeDecision.confidence})`);
        } else {
            // Not a POD - route to quarantine
            const routeDecision = autoRoute.route({ classification, match: null, sender: from });

            models.updateAttachmentStatus(attachmentData.id, routeDecision.routeTo, {
                classificationConfidence: classification.confidence,
                routingDecision: routeDecision.decisionType,
                routingReason: routeDecision.details?.reason
            });

            audit.logRoute(attachmentData.id, routeDecision.routeTo, {
                decisionType: routeDecision.decisionType,
                confidence: routeDecision.confidence,
                reason: routeDecision.details?.reason,
                classification: classification
            });

            console.log(`Routed to QUARANTINE: not classified as POD`);
        }

        console.log(`POD saved: ${processed.canonicalFilename}`);

    } catch (error) {
        console.error('Error processing media:', error.message);
        audit.logFailed(null, error, { from, correlationId });
        throw error;
    }
}

// ============================================
// Process text message
// ============================================
async function processTextMessage(message, from, senderName, receivedAt, correlationId) {
    const cleanFrom = from.replace('@c.us', '').replace('@g.us', '');

    // Create message record
    const messageData = models.createMessage({
        chat_id: from,
        sender_id: cleanFrom,
        received_at: receivedAt.toISOString(),
        status: 'RECEIVED',
        correlation_id: correlationId,
        metadata: {
            whatsappMessageId: message.id._serialized,
            senderName,
            body: message.body
        }
    });

    audit.logIngest(messageData.id, {
        sender: from,
        senderName,
        messageType: 'text',
        preview: message.body.substring(0, 100)
    });

    // Save text to legacy format
    const timestamp = Date.now();
    const textFile = path.join(TEXT_DIR, `${timestamp}_${cleanFrom}.json`);
    const textData = {
        timestamp: receivedAt.toISOString(),
        from,
        sender: senderName,
        body: message.body,
        isGroup: (await message.getChat()).isGroup,
        correlationId
    };
    fs.writeFileSync(textFile, JSON.stringify(textData, null, 2));
    console.log(`Text saved: ${path.basename(textFile)}`);
}

// ============================================
// API Endpoints
// ============================================

// Landing page
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp POD Service</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
        h1 { color: #333; }
        .links { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        a { display: block; padding: 10px; margin: 5px 0; color: #25D366; text-decoration: none; border-bottom: 1px solid #eee; }
        a:hover { background: #f9f9f9; }
        .status { display: inline-block; padding: 5px 15px; border-radius: 20px; background: ${isReady ? '#25D366' : '#f5f5f5'}; color: ${isReady ? 'white' : '#666'}; }
    </style>
</head>
<body>
    <h1>WhatsApp POD Service</h1>
    <p>Status: <span class="status">${isReady ? 'Connected' : 'Disconnected'}</span></p>
    <div class="links">
        <a href="/qr">QR Code (for authentication)</a>
        <a href="/status">Status (JSON)</a>
        <a href="/health">Health Check</a>
        <a href="/api/queue/review">Review Queue</a>
        <a href="/api/queue/out">Out Queue</a>
    </div>
</body>
</html>
    `);
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        ready: isReady,
        uptime: process.uptime()
    });
});

// Status endpoint
app.get('/status', (req, res) => {
    res.json({
        connected: isReady,
        uptime: process.uptime()
    });
});

// QR Code page
app.get('/qr', (req, res) => {
    if (isReady) {
        return res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp Connected</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #25D366; color: white; }
        h1 { font-size: 2em; }
        .status { font-size: 1.5em; margin-top: 20px; }
    </style>
</head>
<body>
    <h1>WhatsApp POD Service</h1>
    <div class="status">Connected and ready!</div>
    <p>Click <a href="/status" style="color: white;">here</a> for status.</p>
</body>
</html>
        `);
    }

    if (!currentQRCode) {
        return res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp Authentication</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        h1 { color: #333; }
        .loading { color: #666; margin-top: 20px; }
    </style>
    <meta http-equiv="refresh" content="5">
</head>
<body>
    <h1>WhatsApp POD Service</h1>
    <p class="loading">Waiting for QR code...</p>
</body>
</html>
        `);
    }

    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp Authentication</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        h1 { color: #333; }
        .qr-container { background: white; padding: 20px; display: inline-block; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        img { width: 256px; height: 256px; }
        .instructions { color: #666; margin-top: 20px; }
        .refresh { color: #999; font-size: 0.8em; margin-top: 10px; }
    </style>
    <meta http-equiv="refresh" content="15">
</head>
<body>
    <h1>WhatsApp POD Service</h1>
    <p>Scan this QR code with WhatsApp</p>
    <div class="qr-container">
        <img src="data:image/png;base64,${currentQRCode}" alt="QR Code">
    </div>
    <p class="instructions">
        1. Open WhatsApp on your phone<br>
        2. Tap Menu or Settings > Linked Devices<br>
        3. Tap "Link a Device"<br>
        4. Point your phone at this screen
    </p>
    <p class="refresh">QR refreshes every 30 seconds</p>
</body>
</html>
    `);
});

// Queue API - Enhanced with filtering and pagination
app.get('/api/queue/review', (req, res) => {
    try {
        const status = req.query.status || 'REVIEW';
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;

        const attachments = models.getAttachmentsByStatus(status, limit + 1);
        const hasMore = attachments.length > limit;
        const data = hasMore ? attachments.slice(0, limit) : attachments;

        res.json({
            count: data.length,
            total: models.getAttachmentsByStatus(status, 10000).length,
            hasMore,
            offset,
            limit,
            attachments: data
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/queue/out', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const attachments = models.getAttachmentsForOut(limit);
        res.json({ count: attachments.length, attachments });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Queue stats
app.get('/api/queue/stats', (req, res) => {
    try {
        const review = models.getAttachmentsByStatus('REVIEW', 10000).length;
        const out = models.getAttachmentsByStatus('OUT', 10000).length;
        const quarantine = models.getAttachmentsByStatus('QUARANTINE', 10000).length;
        const failed = models.getAttachmentsByStatus('FAILED', 10000).length;

        res.json({
            REVIEW: review,
            OUT: out,
            QUARANTINE: quarantine,
            FAILED: failed,
            total: review + out + quarantine + failed
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Approve/Reject convenience endpoints
app.post('/api/attachments/:id/approve', (req, res) => {
    try {
        const { jobRef, vehicleReg } = req.body;
        const result = models.updateAttachmentStatus(req.params.id, 'OUT', { jobRef, vehicleReg });
        if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

        audit.logReview(req.params.id, 'reviewer', 'approve', { jobRef, vehicleReg });
        audit.logRoute(req.params.id, 'OUT', { reason: 'Approved by reviewer' });

        res.json(models.getAttachmentById(req.params.id));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/attachments/:id/reject', (req, res) => {
    try {
        const { reason, notes } = req.body;
        const result = models.updateAttachmentStatus(req.params.id, 'QUARANTINE');
        if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

        audit.logReview(req.params.id, 'reviewer', 'reject', { reason, notes });

        res.json(models.getAttachmentById(req.params.id));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bulk actions
app.post('/api/queue/bulk-action', (req, res) => {
    try {
        const { action, ids, notes } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'ids array required' });
        }

        const results = [];
        for (const id of ids) {
            try {
                let newStatus;
                if (action === 'approve') newStatus = 'OUT';
                else if (action === 'reject') newStatus = 'QUARANTINE';
                else if (action === 'review') newStatus = 'REVIEW';
                else return res.status(400).json({ error: 'Invalid action' });

                const result = models.updateAttachmentStatus(id, newStatus);
                if (result.changes > 0) {
                    audit.logReview(id, 'reviewer', `bulk_${action}`, { notes, count: ids.length });
                    results.push({ id, success: true });
                } else {
                    results.push({ id, success: false, error: 'Not found' });
                }
            } catch (err) {
                results.push({ id, success: false, error: err.message });
            }
        }

        res.json({
            action,
            processed: results.length,
            success: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            results
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// File serving
app.get('/api/files/:id', (req, res) => {
    try {
        const attachment = models.getAttachmentById(req.params.id);
        if (!attachment) return res.status(404).json({ error: 'Not found' });

        let filePath = attachment.storage_uri;
        if (filePath.startsWith('s3://')) {
            return res.json({ message: 'S3 file - configure S3 endpoint to download', uri: filePath });
        }

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found on disk', path: filePath });
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.pdf': 'application/pdf'
        };

        res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${attachment.canonical_filename}"`);
        res.sendFile(filePath);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Audit API
app.get('/api/audit/:attachmentId', (req, res) => {
    try {
        const trail = audit.getAttachmentAuditTrail(req.params.attachmentId);
        res.json({ attachmentId: req.params.attachmentId, count: trail.length, trail });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Attachment endpoints
app.get('/api/attachments/:id', (req, res) => {
    try {
        const attachment = models.getAttachmentById(req.params.id);
        if (!attachment) return res.status(404).json({ error: 'Not found' });
        res.json(attachment);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/attachments/:id', (req, res) => {
    try {
        const { status, jobRef, vehicleReg } = req.body;
        const result = models.updateAttachmentStatus(req.params.id, status, { jobRef, vehicleReg });
        if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

        if (status) {
            audit.logReview(req.params.id, 'reviewer', 'status_update', { newStatus: status, jobRef, vehicleReg });
        }

        res.json(models.getAttachmentById(req.params.id));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Send message (handles both 'to' and 'chat_id' for compatibility)
app.post('/api/send', async (req, res) => {
    const { to, chat_id, text, message } = req.body;
    const target = to || chat_id;
    const msgText = text || message;
    if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });
    if (!target) return res.status(400).json({ error: 'Missing target (to/chat_id)' });

    try {
        const chatId = target.includes('@') ? target : `${target}@g.us`;  // Group IDs
        await client.sendMessage(chatId, msgText);
        res.json({ success: true, sent_to: chatId });
    } catch (error) {
        console.error('[Send] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Broadcast message to multiple recipients
app.post('/api/broadcast/send', async (req, res) => {
    const { recipients, message } = req.body;
    if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'Missing or empty recipients array' });
    }
    if (!message) return res.status(400).json({ error: 'Missing message' });

    const delivered = [];
    const failed = [];

    console.log(`[Broadcast] Sending to ${recipients.length} recipients`);

    // Fetch all chats/groups once to resolve names to chat objects
    let allChats = [];
    try {
        allChats = await client.getChats();
        console.log(`[Broadcast] Loaded ${allChats.length} chats/groups`);
    } catch (error) {
        console.error('[Broadcast] Failed to fetch chats:', error.message);
    }

    for (const recipient of recipients) {
        try {
            // Handle both string and object recipients
            let chatId;

            if (typeof recipient === 'string') {
                // String recipient - check if it has @
                if (recipient.includes('@')) {
                    // Direct chat ID
                    chatId = recipient;
                } else {
                    // Name without @ - find the chat first
                    const chat = allChats.find(c =>
                        c.name === recipient ||
                        c.id._serialized === `${recipient}@c.us` ||
                        c.id._serialized === `${recipient}@g.us` ||
                        c.id.user === recipient
                    );
                    if (!chat) {
                        throw new Error(`Chat not found: ${recipient}`);
                    }
                    chatId = chat.id._serialized;
                }
                // Send the message
                // Add delay to ensure chat is fully loaded
                await new Promise(resolve => setTimeout(resolve, 500));
                // Check if chat is ready by trying to get it
                try {
                    await client.sendMessage(chatId, message);
                    delivered.push(recipient);
                    console.log(`[Broadcast] ✓ Delivered to ${chatId}`);
                } catch (err) {
                    // If error contains markedUnread, try once more with longer delay
                    if (err.message.includes('markedUnread')) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        await client.sendMessage(chatId, message);
                        delivered.push(recipient);
                        console.log(`[Broadcast] ✓ Delivered to ${chatId} (retry)`);
                    } else {
                        throw err;
                    }
                }
            } else if (typeof recipient === 'object' && recipient !== null) {
                // Object recipient - check for phone or group property
                if (recipient.group) {
                    // Group recipient - find by name and get ID
                    const groupName = recipient.group;
                    const chat = allChats.find(c =>
                        c.isGroup &&
                        (c.name === groupName ||
                         c.id._serialized === `${groupName}@g.us`)
                    );
                    if (!chat) {
                        throw new Error(`Group not found: ${groupName}`);
                    }
                    // Use the chat ID directly
                    chatId = chat.id._serialized;
                    // Add delay to ensure chat is fully loaded
                    await new Promise(resolve => setTimeout(resolve, 500));
                    // Check if chat is ready by trying to get it
                    try {
                        await client.sendMessage(chatId, message);
                        delivered.push(recipient);
                        console.log(`[Broadcast] ✓ Delivered to ${chat.name || chatId}`);
                    } catch (err) {
                        // If error contains markedUnread, try once more with longer delay
                        if (err.message.includes('markedUnread')) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            await client.sendMessage(chatId, message);
                            delivered.push(recipient);
                            console.log(`[Broadcast] ✓ Delivered to ${chat.name || chatId} (retry)`);
                        } else {
                            throw err;
                        }
                    }
                } else if (recipient.phone) {
                    // Individual phone recipient
                    const phone = recipient.phone;
                    if (phone.includes('@')) {
                        chatId = phone;
                    } else {
                        chatId = `${phone}@c.us`;
                    }
                    // Add delay to ensure chat is fully loaded
                    await new Promise(resolve => setTimeout(resolve, 500));
                    // Check if chat is ready by trying to get it
                    try {
                        await client.sendMessage(chatId, message);
                        delivered.push(recipient);
                        console.log(`[Broadcast] ✓ Delivered to ${chatId}`);
                    } catch (err) {
                        // If error contains markedUnread, try once more with longer delay
                        if (err.message.includes('markedUnread')) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            await client.sendMessage(chatId, message);
                            delivered.push(recipient);
                            console.log(`[Broadcast] ✓ Delivered to ${chatId} (retry)`);
                        } else {
                            throw err;
                        }
                    }
                } else {
                    throw new Error('Invalid recipient object - must have group or phone property');
                }
            } else {
                throw new Error('Invalid recipient type - must be string or object');
            }
        } catch (error) {
            failed.push({ recipient, error: error.message });
            console.error(`[Broadcast] ✗ Failed for`, recipient, ':', error.message);
        }
    }

    res.json({
        success: true,
        delivered: delivered.length,
        failed: failed.length,
        details: { delivered, failed }
    });
});

// Get all available groups
app.get('/api/broadcast/groups', async (req, res) => {
    if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });

    try {
        const allChats = await client.getChats();
        const groups = allChats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name,
                participantCount: chat.participants ? chat.participants.length : 0
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        res.json({
            count: groups.length,
            groups
        });
    } catch (error) {
        console.error('[Groups] Error fetching groups:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Legacy endpoint for compatibility
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });

    try {
        await client.sendMessage(number, message);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reconnect WhatsApp (old path)
app.post('/api/reconnect', async (req, res) => {
    try {
        console.log('Initiating WhatsApp reconnection...');
        isReady = false;

        // Destroy existing client
        if (client) {
            try {
                await client.destroy();
                console.log('Client destroyed');
            } catch (error) {
                console.error('Error destroying client:', error);
            }
        }

        // Reinitialize
        initWhatsApp();

        res.json({
            success: true,
            message: 'Reconnection initiated'
        });
    } catch (error) {
        console.error('[Reconnect] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Reconnect WhatsApp (new path for /whatsapp-status/)
app.post('/whatsapp-status/api/reconnect', async (req, res) => {
    try {
        console.log('Initiating WhatsApp reconnection...');
        isReady = false;

        // Destroy existing client
        if (client) {
            try {
                await client.destroy();
                console.log('Client destroyed');
            } catch (error) {
                console.error('Error destroying client:', error);
            }
        }

        // Reinitialize
        initWhatsApp();

        res.json({
            success: true,
            message: 'Reconnection initiated'
        });
    } catch (error) {
        console.error('[Reconnect] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Restart service
app.post('/api/restart', async (req, res) => {
    try {
        console.log('Restarting service...');
        res.json({
            success: true,
            message: 'Restart command sent'
        });

        // Give the response time to be sent before restarting
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    } catch (error) {
        console.error('[Restart] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    if (client) await client.destroy();
    emailQueue.stopProcessor();
    process.exit(0);
});

// ============================================
// Email Queue Endpoints
// ============================================

// Email status dashboard
app.get('/api/email/status', (req, res) => {
    try {
        const queueStats = emailQueue.getQueueStats();
        const emailStatus = email.getStatus();
        const recipientStatus = recipients.getStatus();

        res.json({
            queue: queueStats,
            email: emailStatus,
            recipients: recipientStatus,
            processor: {
                running: !!processorInterval,
                pollInterval: POLL_INTERVAL
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Email bounce webhook (for SMTP providers like SendGrid, Mailgun)
app.post('/api/email/bounce', (req, res) => {
    try {
        const { messageId, email: bouncedEmail, reason, type, timestamp } = req.body;

        console.log(`Bounce received: ${bouncedEmail} - ${reason}`);

        const db = getDb();

        // Find the email record
        const emailRecord = db.prepare(`
            SELECT * FROM email_queue WHERE message_id = ? OR id = ?
        `).get(messageId, messageId);

        if (!emailRecord) {
            return res.status(404).json({ error: 'Email not found' });
        }

        const isHardBounce = type === 'hard' ||
            reason.toLowerCase().includes('invalid') ||
            reason.toLowerCase().includes('does not exist');

        // Update status
        db.prepare(`
            UPDATE email_queue
            SET status = ?, error = ?
            WHERE id = ?
        `).run(isHardBounce ? 'BOUNCED' : 'FAILED', reason, emailRecord.id);

        // Log delivery event
        emailQueue.logDeliveryEvent(emailRecord.id, emailRecord.attachment_id, 'BOUNCED', {
            bouncedEmail,
            reason,
            type,
            timestamp
        });

        // Audit log
        audit.log({
            action: 'EMAIL_BOUNCED',
            attachmentId: emailRecord.attachment_id,
            details: { messageId, bouncedEmail, reason, isHardBounce }
        });

        // Alert for hard bounces
        if (isHardBounce) {
            console.log(`ALERT: Hard bounce for ${bouncedEmail}`);
            // Could trigger alert here
        }

        res.json({ success: true, processed: true });
    } catch (error) {
        console.error('Bounce处理 error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get queue statistics
app.get('/api/email/queue', (req, res) => {
    try {
        const stats = emailQueue.getQueueStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get delivery log for an email
app.get('/api/email/queue/:id/log', (req, res) => {
    try {
        const log = emailQueue.getDeliveryLog(req.params.id);
        res.json({ emailQueueId: req.params.id, log });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manually queue email for an attachment
app.post('/api/attachments/:id/email', async (req, res) => {
    try {
        const attachment = models.getAttachmentById(req.params.id);
        if (!attachment) return res.status(404).json({ error: 'Not found' });

        const { to, cc, subject, body } = req.body;

        const emailQueueId = emailQueue.queueEmail({
            attachmentId: attachment.id,
            to: to || [],
            cc: cc || [],
            bcc: [],
            subject: subject || email.generateSubject({ jobRef: attachment.job_ref, vehicleReg: attachment.vehicle_reg }),
            body: body || null,
            attachmentPath: attachment.storage_uri,
            attachmentName: attachment.canonical_filename
        });

        res.json({ success: true, emailQueueId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Retry failed email
app.post('/api/email/queue/:id/retry', (req, res) => {
    try {
        const success = emailQueue.retryEmail(req.params.id);
        if (!success) return res.status(404).json({ error: 'Email not found or cannot be retried' });

        res.json({ success: true, message: 'Email requeued' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Cancel queued email
app.delete('/api/email/queue/:id', (req, res) => {
    try {
        const success = emailQueue.cancelEmail(req.params.id);
        if (!success) return res.status(404).json({ error: 'Email not found or cannot be cancelled' });

        res.json({ success: true, message: 'Email cancelled' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// End Email Queue Endpoints
// ============================================

// ============================================
// Retention & Governance Endpoints
// ============================================

// Retention stats
app.get('/api/retention/stats', (req, res) => {
    try {
        const stats = retention.getStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get retention rule for an attachment
app.get('/api/retention/attachment/:id', (req, res) => {
    try {
        const attachment = models.getAttachmentById(req.params.id);
        if (!attachment) return res.status(404).json({ error: 'Not found' });

        const rule = retention.getRetentionExpiry(attachment);
        res.json({ attachment, retention: rule });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Run retention cleanup (dry run by default)
app.post('/api/retention/cleanup', async (req, res) => {
    try {
        const { dryRun = true, limit = 100 } = req.body;
        const result = await retention.runCleanup({ dryRun, limit });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Apply retention action to single attachment
app.post('/api/retention/apply/:id', async (req, res) => {
    try {
        const { dryRun = false } = req.body;
        const result = await retention.applyRetention(req.params.id, { dryRun });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Set retention rule
app.post('/api/retention/rules', (req, res) => {
    try {
        const rule = retention.setRule(req.body);
        res.json({ success: true, rule });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Legal Hold Endpoints
// ============================================

// Get hold stats
app.get('/api/legal-holds/stats', (req, res) => {
    try {
        const stats = legalHold.getStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all active holds
app.get('/api/legal-holds', (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        const holds = legalHold.getActiveHolds({ limit: parseInt(limit), offset: parseInt(offset) });
        res.json({ count: holds.length, holds });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Apply hold to attachment
app.post('/api/legal-holds/apply', (req, res) => {
    try {
        const { attachmentId, reason, expiresAt, notes } = req.body;
        const result = legalHold.applyHold(attachmentId, { reason, expiresAt, notes });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Release hold
app.post('/api/legal-holds/:id/release', (req, res) => {
    try {
        const { releasedBy, releaseReason } = req.body;
        const result = legalHold.releaseHold(req.params.id, { releasedBy, releaseReason });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Check if attachment is protected
app.get('/api/legal-holds/check/:attachmentId', (req, res) => {
    try {
        const isProtected = legalHold.isProtected(req.params.attachmentId);
        const holds = legalHold.getAttachmentHolds(req.params.attachmentId);
        res.json({ protected: isProtected, holds });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Archive Endpoints
// ============================================

// List archived items
app.get('/api/archive', (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        const items = archive.list({ limit: parseInt(limit), offset: parseInt(offset) });
        res.json({ count: items.length, items });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get archive stats
app.get('/api/archive/stats', (req, res) => {
    try {
        const stats = archive.getStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Archive an attachment
app.post('/api/archive/:id', (req, res) => {
    try {
        const { dryRun = false } = req.body;
        const result = archive.archive(req.params.id, { dryRun });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Restore from archive
app.post('/api/archive/:id/restore', (req, res) => {
    try {
        const { dryRun = false } = req.body;
        const result = archive.restore(req.params.id, { dryRun });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Evidence Bundle Endpoints
// ============================================

// List export bundles
app.get('/api/evidence', (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        const bundles = evidence.listBundles({ limit: parseInt(limit), offset: parseInt(offset) });
        res.json({ count: bundles.length, bundles });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get bundle details
app.get('/api/evidence/:bundleId', (req, res) => {
    try {
        const bundle = evidence.getBundle(req.params.bundleId);
        if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
        res.json(bundle);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create evidence bundle
app.post('/api/evidence', async (req, res) => {
    try {
        const {
            attachmentIds,
            dateFrom,
            dateTo,
            status,
            customerName,
            jobRefPattern,
            password,
            dryRun = false
        } = req.body;

        const result = await evidence.createBundle({
            attachmentIds,
            dateFrom,
            dateTo,
            status,
            customerName,
            jobRefPattern,
            password,
            dryRun,
            createdBy: req.body.createdBy || 'api'
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Verify bundle integrity
app.get('/api/evidence/:bundleId/verify', async (req, res) => {
    try {
        const result = await evidence.verifyBundle(req.params.bundleId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download bundle (redirect to file)
app.get('/api/evidence/:bundleId/download', (req, res) => {
    try {
        const bundle = evidence.getBundle(req.params.bundleId);
        if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

        const zipPath = path.join(evidence.EXPORT_PATH, `${req.params.bundleId}.zip`);
        if (!fs.existsSync(zipPath)) {
            return res.status(404).json({ error: 'ZIP file not found' });
        }

        res.download(zipPath, `evidence-${req.params.bundleId}.zip`);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Scheduler Endpoints
// ============================================

// Get scheduler status
app.get('/api/scheduler', (req, res) => {
    try {
        const status = scheduler.getStatus();
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Trigger job manually
app.post('/api/scheduler/run/:jobName', async (req, res) => {
    try {
        const { dryRun = false, force = false } = req.body;
        const result = await scheduler.triggerJob(req.params.jobName, { dryRun, force });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Phase 5: Operations & Monitoring Endpoints
// ============================================

// Enhanced health check with full details
app.get('/health', async (req, res) => {
    try {
        const level = req.query.level || 'deep';
        const result = await health.checkHealth({ level });
        res.json(result);
    } catch (error) {
        res.status(500).json({ status: 'unhealthy', error: error.message });
    }
});

// Prometheus metrics format
app.get('/metrics', (req, res) => {
    try {
        const format = req.query.format || 'json';
        if (format === 'prometheus') {
            res.set('Content-Type', 'text/plain');
            res.send(metrics.getMetricsPrometheus());
        } else {
            res.json(metrics.getMetricsJSON());
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Dashboard metrics (simplified for UI)
app.get('/api/metrics', (req, res) => {
    try {
        res.json(metrics.getDashboardSummary());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Processing metrics
app.get('/api/metrics/processing', (req, res) => {
    try {
        res.json(metrics.getProcessingMetrics());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Queue metrics
app.get('/api/metrics/queues', (req, res) => {
    try {
        res.json(metrics.getQueueMetrics());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Alert Endpoints
// ============================================

// Get active alerts
app.get('/api/alerts/active', (req, res) => {
    try {
        res.json(alerts.getActiveAlerts());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get alert history
app.get('/api/alerts/history', (req, res) => {
    try {
        const { level, limit = 100 } = req.query;
        res.json(alerts.getHistory({ level, limit: parseInt(limit) }));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get alert rules
app.get('/api/alerts/rules', (req, res) => {
    try {
        res.json(alerts.getRules());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get alert statistics
app.get('/api/alerts/stats', (req, res) => {
    try {
        res.json(alerts.getStats());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Acknowledge alert
app.post('/api/alerts/acknowledge/:id', (req, res) => {
    try {
        const { by = 'api' } = req.body;
        const success = alerts.acknowledgeAlert(req.params.id, by);
        res.json({ success });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Silence alert rule
app.post('/api/alerts/silence/:ruleId', (req, res) => {
    try {
        const { minutes = 60 } = req.body;
        const result = alerts.silenceRule(req.params.ruleId, minutes);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clear all active alerts
app.post('/api/alerts/clear', (req, res) => {
    try {
        const { by = 'api' } = req.body;
        const count = alerts.clearAlerts(by);
        res.json({ cleared: count });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manually trigger alert check
app.post('/api/alerts/check', async (req, res) => {
    try {
        const triggered = await alerts.checkRules();
        res.json({ checked: true, triggered });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Runbook Endpoints
// ============================================

// List all runbooks
app.get('/api/runbooks', (req, res) => {
    try {
        const { severity, search } = req.query;
        res.json(runbooks.list({ severity, search }));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get single runbook
app.get('/api/runbooks/:id', (req, res) => {
    try {
        const runbook = runbooks.get(req.params.id);
        if (!runbook) return res.status(404).json({ error: 'Runbook not found' });
        res.json(runbook);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Search runbooks by symptom
app.get('/api/runbooks/search/symptom', (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'q parameter required' });
        res.json(runbooks.searchBySymptom(q));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get runbooks by related alert
app.get('/api/runbooks/by-alert/:alertId', (req, res) => {
    try {
        res.json(runbooks.getByAlert(req.params.alertId));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get severity levels
app.get('/api/runbooks/severities', (req, res) => {
    try {
        res.json(runbooks.getSeverityLevels());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get quick reference (summary)
app.get('/api/runbooks/quick', (req, res) => {
    try {
        res.json(runbooks.getQuickReference());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Export Endpoints (Phase 3 prep)
// ============================================

// Create export record
app.post('/api/exports', (req, res) => {
    try {
        const { attachment_id, export_type = 'MANUAL', recipients, subject, body, message_id } = req.body;

        if (!attachment_id) {
            return res.status(400).json({ error: 'attachment_id is required' });
        }

        // Parse recipients if string (comma-separated)
        let parsedRecipients = recipients;
        if (typeof recipients === 'string') {
            parsedRecipients = recipients.split(',').map(e => e.trim()).filter(e => e);
        }

        const exportData = {
            attachment_id,
            message_id,
            export_type,
            recipients: parsedRecipients,
            subject,
            body
        };

        const exportRecord = models.createExport(exportData);

        // Log export prepared
        audit.logExportPrepared(attachment_id, exportRecord.id, {
            exportType: export_type,
            recipientCount: parsedRecipients?.length || 0
        });

        res.status(201).json(exportRecord);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create export from attachment (convenience endpoint)
app.post('/api/attachments/:id/export', (req, res) => {
    try {
        const attachmentId = req.params.id;
        const { recipients, subject, body, export_type = 'MANUAL' } = req.body;

        // Verify attachment exists
        const attachment = models.getAttachmentById(attachmentId);
        if (!attachment) {
            return res.status(404).json({ error: 'Attachment not found' });
        }

        // Parse recipients if string
        let parsedRecipients = recipients;
        if (typeof recipients === 'string') {
            parsedRecipients = recipients.split(',').map(e => e.trim()).filter(e => e);
        }

        // Auto-generate subject if not provided
        const autoSubject = subject || `POD for ${attachment.job_ref || attachment.vehicle_reg || 'Delivery'}`;

        const exportData = {
            attachment_id: attachmentId,
            message_id: attachment.message_id,
            export_type,
            recipients: parsedRecipients,
            subject: autoSubject,
            body
        };

        const exportRecord = models.createExport(exportData);

        // Log export action
        audit.logExport(attachmentId, parsedRecipients, {
            exportId: exportRecord.id,
            exportType: export_type,
            subject: autoSubject
        });

        res.status(201).json(exportRecord);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List exports with filtering
app.get('/api/exports', (req, res) => {
    try {
        const { status, limit = 100, offset = 0 } = req.query;
        const exports = models.getAllExports({
            status,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        res.json(exports);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get single export with attachment details
app.get('/api/exports/:id', (req, res) => {
    try {
        const exportRecord = models.getExportByIdWithAttachment(req.params.id);
        if (!exportRecord) {
            return res.status(404).json({ error: 'Export not found' });
        }
        res.json(exportRecord);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get export history with pagination
app.get('/api/exports/history', (req, res) => {
    try {
        const { limit = 100, offset = 0, status } = req.query;
        const exports = models.getAllExports({
            status,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        res.json({
            exports,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get pending exports (for Phase 3 processing)
app.get('/api/exports/pending', (req, res) => {
    try {
        const pending = models.getPendingExports();
        res.json(pending);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get exports by attachment ID
app.get('/api/attachments/:id/exports', (req, res) => {
    try {
        const exports = models.getExportsByAttachmentId(req.params.id);
        res.json(exports);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update export status
app.patch('/api/exports/:id/status', (req, res) => {
    try {
        const { status, error } = req.body;
        const result = models.updateExportStatus(req.params.id, status, { error });
        res.json({ success: true, changes: result.changes });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Mark export as delivered
app.post('/api/exports/:id/deliver', (req, res) => {
    try {
        const result = models.markExportDelivered(req.params.id);
        res.json({ success: true, changes: result.changes });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Mark export as failed
app.post('/api/exports/:id/fail', (req, res) => {
    try {
        const { error } = req.body;
        if (!error) {
            return res.status(400).json({ error: 'error message required' });
        }
        const result = models.markExportFailed(req.params.id, error);
        res.json({ success: true, changes: result.changes });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// End Phase 5 Endpoints
// ============================================

// ============================================
// Phase 5: Start Background Services
// ============================================

// Start scheduled jobs
scheduler.startScheduler();

// Start alert checker interval (every 60 seconds)
const ALERT_CHECK_INTERVAL = 60 * 1000; // 60 seconds
setInterval(async () => {
    try {
        await alerts.checkRules();
    } catch (error) {
        console.error('Alert check error:', error.message);
    }
}, ALERT_CHECK_INTERVAL);

console.log(`Scheduler started, alert checker running (${ALERT_CHECK_INTERVAL}ms interval)`);

// ============================================
// End Background Services
// ============================================

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';  // Bind to all interfaces
app.listen(PORT, HOST, () => {
    console.log(`WhatsApp POD Service on ${HOST}:${PORT}`);
    console.log(`Email queue processor: Use /api/email/status to check status`);
    initWhatsApp();
});
