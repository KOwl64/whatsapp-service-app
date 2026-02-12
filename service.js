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
// Import Phase 2 Auto-Send module
const autoSend = require('./lib/auto-send');
// Import Phase 4 modules
const retention = require('./retention');
const legalHold = require('./legalHold');
const archive = require('./archive');
const evidence = require('./evidence');
const scheduler = require('./scheduler');

// Import Storage modules (R2)
const presignedUrls = require('./lib/presigned-urls');

// Import Event Emitter module
const eventEmitter = require('./lib/events');

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', reason);
    console.error('[UNHANDLED REJECTION] Stack:', reason?.stack);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION]', error.message);
    console.error('[UNHANDLED REJECTION] Stack:', error.stack);
});
const mimeTypes = require('./lib/mime-types');
const storage = require('./lib/storage');

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

// ============================================
// Stability & Circuit Breaker State
// ============================================
const stability = {
    startTime: Date.now(),
    restartCount: 0,
    lastErrorTime: null,
    lastErrorMessage: null,
    consecutiveFailures: 0,
    circuitState: 'closed', // closed, open, half-open
    circuitOpenedAt: null,
    maxFailures: 5,
    baseDelay: 1000,
    maxDelay: 60000,
    memoryLogs: []
};

// Get restart count from PM2 env
const pm2Env = process.env.pm_id ? parseInt(process.env.pm_id) : 0;
// Track process restarts via PM2 monitoring


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

// Initialize event emitter
eventEmitter.connect().catch(err => {
    console.error('[EVENTS] Failed to connect:', err.message);
});

// Initialize Phase 2 modules (classification and OCR) with shared OpenAI client
try {
    const OpenAI = require('openai');
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
        const openaiClient = new OpenAI({ apiKey });
        classify.init({ client: openaiClient });
        ocr.init({ client: openaiClient });
        console.log('Phase 2 modules initialized: classify and OCR ready');
    } else {
        console.warn('OPENAI_API_KEY not set - classification/OCR will use fallback mode');
    }
} catch (initError) {
    console.error('Failed to initialize Phase 2 modules:', initError.message);
}

// Initialize Phase 2 Auto-Send rules
try {
    const autoSendConfig = autoSend.loadConfig();
    console.log('[AutoSend] Configuration loaded:', autoSend.getConfigSummary().enabled ? 'enabled' : 'disabled');
} catch (initError) {
    console.error('[AutoSend] Failed to initialize:', initError.message);
}

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
    console.log('[INIT] initWhatsApp() called');
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
        puppeteer: {
            headless: true,
            dumpio: true,
            executablePath: '/usr/bin/chromium-browser',
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
        qrcode.generate(qr, { small: false });

        // Store QR for web display
        try {
            const QRCode = require('qrcode');
            currentQRCode = await QRCode.toDataURL(qr);
            currentQRCode = currentQRCode.replace('data:image/png;base64,', '');
        } catch (err) {
            console.error('Error generating QR for web:', err.message);
        }

        // Emit connection status
        eventEmitter.emitConnectionStatus('qr', { qrGenerated: true });
    });

    client.on('ready', () => {
        console.log('WhatsApp POD Service Ready!');
        isReady = true;
        currentQRCode = null; // Clear QR after successful auth

        // Reset circuit breaker on successful connection
        if (stability.circuitState !== 'closed') {
            console.log('[CIRCUIT] Closed - connection restored');
            stability.circuitState = 'closed';
            stability.consecutiveFailures = 0;
            stability.circuitOpenedAt = null;
        }
    });

    client.on('authenticated', () => {
        console.log('[AUTH] Authentication successful!');
    });

    // Debug: Track state changes
    client.on('change_state', (state) => {
        console.log('[DEBUG] WhatsApp state changed to:', state);
    });

    // Debug: Track loading screen
    client.on('loading_screen', (percent, message) => {
        console.log(`[DEBUG] Loading screen: ${percent}% - ${message}`);
    });

    // Debug: Track any incoming events
    client.on('incoming_call', (call) => {
        console.log('[DEBUG] Incoming call:', call.from);
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
        console.log('[DISCONNECT] Client disconnected:', reason);
        isReady = false;
        stability.lastErrorTime = new Date().toISOString();
        stability.lastErrorMessage = reason;
        stability.consecutiveFailures++;

        // Circuit breaker logic
        if (stability.consecutiveFailures >= stability.maxFailures) {
            stability.circuitState = 'open';
            stability.circuitOpenedAt = Date.now();
            const delay = Math.min(
                stability.baseDelay * Math.pow(2, stability.consecutiveFailures - stability.maxFailures),
                stability.maxDelay
            );
            console.log(`[CIRCUIT] Open - waiting ${delay}ms before retry`);
            setTimeout(() => {
                stability.circuitState = 'half-open';
                console.log('[CIRCUIT] Half-open - attempting reconnect...');
                initWhatsApp();
            }, delay);
        } else {
            // Exponential backoff
            const delay = stability.baseDelay * Math.pow(2, stability.consecutiveFailures - 1);
            console.log(`[RECONNECT] Attempting reconnection in ${delay}ms (failure ${stability.consecutiveFailures})`);
            setTimeout(() => {
                initWhatsApp();
            }, delay);
        }
    });

    // Debug: Track remote sessions
    client.on('remote_session', (session) => {
        console.log('[DEBUG] Remote session:', session);
    });

    // Debug: Track revocation events
    client.on('revoked', (info) => {
        console.log('[DEBUG] Revoked:', info);
    });

    // Debug: Track pairing code
    client.on('pairing_code', (code) => {
        console.log('[DEBUG] Pairing code:', code);
    });

    console.log('[INIT] Client events registered, calling initialize()...');

    try {
        client.initialize();
        console.log('[INIT] client.initialize() returned (async)');
    } catch (error) {
        console.error('[ERROR] client.initialize() threw:', error.message);
        console.error('[ERROR] Stack:', error.stack);
    }
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

        // ============================================
        // Phase 2: Classification BEFORE creating attachment
        // ============================================

        // Read file buffer for classification
        const imageBuffer = fs.readFileSync(processed.storagePath);

        // Classify the image
        let classification;
        try {
            classification = await classify.classify(imageBuffer, mimeType);
        } catch (classError) {
            console.error('Classification error:', classError.message);
            classification = {
                type: 'UNKNOWN',
                imageType: 'error',
                confidence: 0.0,
                isPOD: null,
                reason: `Classification failed: ${classError.message}`
            };
        }

        // Log classification attempt
        audit.log({
            action: 'CLASSIFY_ATTEMPTED',
            attachmentId: null,
            correlationId,
            details: {
                fileType: processed.fileType,
                fileSize: processed.fileSize,
                contentHash: processed.contentHash
            }
        });

        console.log(`Classification: type=${classification.type}, confidence=${classification.confidence}, isPOD=${classification.isPOD}`);

        // Handle NON_POD images with high confidence - skip attachment creation
        if (classification.type === 'NON_POD' && classification.confidence >= 0.9) {
            console.log(`Rejecting NON_POD image: ${classification.imageType} (confidence: ${classification.confidence})`);

            // Log rejection
            audit.log({
                action: 'CLASSIFY_REJECTED',
                attachmentId: null,
                correlationId,
                details: {
                    reason: 'NON_POD classification high confidence',
                    imageType: classification.imageType,
                    confidence: classification.confidence,
                    fileMovedTo: `${STORAGE_BASE}/REJECTED/${path.basename(processed.storagePath)}`
                }
            });

            // Move to REJECTED folder
            const rejectedDir = path.join(STORAGE_BASE, 'REJECTED', new Date().toISOString().split('T')[0]);
            if (!fs.existsSync(rejectedDir)) {
                fs.mkdirSync(rejectedDir, { recursive: true });
            }
            const rejectedPath = path.join(rejectedDir, path.basename(processed.storagePath));
            fs.renameSync(processed.storagePath, rejectedPath);

            console.log(`Image moved to REJECTED folder`);
            return; // Skip further processing
        }

        // For POD, UNKNOWN, or low-confidence images, continue with processing
        // Proceed to create attachment record and continue with OCR
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
        // Phase 2: Run OCR on POD images
        // ============================================

        // 1. Use already-classified result (classification.type is POD)
        // Run OCR asynchronously
        let ocrResult = null;
        let extractedFields = null;

        if (classification.isPOD) {
            // Run OCR with structured extraction
            try {
                console.log('Running structured OCR extraction...');
                ocrResult = await ocr.extractStructured(imageBuffer, mimeType);

                if (ocrResult.success) {
                    // Parse raw OCR text using extractor module for structured fields
                    extractedFields = extractor.extract(ocrResult.rawText || '');

                    // Extract structured fields from OCR result
                    const wordCount = ocrResult.rawText ? ocrResult.rawText.split(/\s+/).filter(w => w.length > 0).length : 0;

                    // Log OCR extraction
                    audit.log({
                        action: 'OCR_EXTRACTED',
                        attachmentId: attachmentData.id,
                        correlationId,
                        details: {
                            wordCount,
                            confidence: ocrResult.confidence,
                            duration: ocrResult.duration,
                            fieldsFound: {
                                supplier: extractedFields.supplier,
                                jobRef: extractedFields.jobRef,
                                vehicleReg: extractedFields.vehicleReg,
                                date: extractedFields.date,
                                shipmentNumber: extractedFields.shipmentNumber
                            }
                        }
                    });

                    console.log(`OCR: supplier=${extractedFields.supplier}, jobRef=${extractedFields.jobRef}, vehicleReg=${extractedFields.vehicleReg}, confidence=${extractedFields.confidence}`);

                    // Log extracted fields with quality score
                    if (extractedFields.confidence > 0) {
                        audit.log({
                            action: 'FIELDS_EXTRACTED',
                            attachmentId: attachmentData.id,
                            correlationId,
                            details: {
                                supplier: extractedFields.supplier,
                                jobRef: extractedFields.jobRef,
                                vehicleReg: extractedFields.vehicleReg,
                                date: extractedFields.date,
                                shipmentNumber: extractedFields.shipmentNumber,
                                confidence: extractedFields.confidence,
                                quality: extractedFields.confidence
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

            // Use new match.findMatch() for comprehensive matching
            if (extractedFields || ocrResult) {
                const matchFields = {
                    jobRef: extractedFields?.jobRef || ocrResult?.jobRef || null,
                    vehicleReg: extractedFields?.vehicleReg || ocrResult?.vehicleReg || null,
                    date: extractedFields?.date || ocrResult?.date || null,
                    supplier: extractedFields?.supplier || null
                };

                // Only attempt matching if we have at least one field
                if (matchFields.jobRef || matchFields.vehicleReg) {
                    console.log(`Matching with extracted fields: jobRef=${matchFields.jobRef}, vehicleReg=${matchFields.vehicleReg}`);
                    jobMatch = await match.findMatch(matchFields, attachmentData.id);

                    // Log match result with confidence
                    console.log(`Match result: status=${jobMatch.summary?.status}, confidence=${jobMatch.match?.confidence || 0}, candidates=${jobMatch.candidates?.length || 0}`);
                }
            }

            // Fallback to sender-based matching if no match found
            if (!jobMatch || !jobMatch.match) {
                jobMatch = await match.findBestMatch({ sender: senderPhone });
                console.log(`Fallback sender match: confidence=${jobMatch.confidence}, matchType=${jobMatch.matchType}`);
            }

            // ============================================
            // Phase 2: Auto-Send Rules Evaluation
            // ============================================

            // Capture attachment ID for audit logging
            const attachmentId = attachmentData.id;

            // Evaluate auto-send decision based on confidence scores
            const confidenceData = {
                id: attachmentId,
                classificationConfidence: classification.confidence,
                extractionConfidence: extractedFields?.confidence || ocrResult?.confidence || 0,
                supplier: extractedFields?.supplier || ocrResult?.supplier || null
            };

            const autoSendDecision = autoSend.shouldAutoSend(confidenceData, jobMatch);
            console.log(`[AutoSend] Decision: ${autoSendDecision.decision}, Reason: ${autoSendDecision.reasonCode}`);

            // Log auto-send decision
            audit.log({
                action: 'AUTO_SEND_DECISION',
                attachmentId: attachmentId,
                correlationId,
                details: {
                    decision: autoSendDecision.decision,
                    reasonCode: autoSendDecision.reasonCode,
                    reason: autoSendDecision.reason,
                    nextAction: autoSendDecision.nextAction,
                    overallConfidence: autoSend.calculateOverallConfidence({
                        classification: classification.confidence,
                        extraction: extractedFields?.confidence || ocrResult?.confidence || 0,
                        matching: jobMatch?.match?.confidence || 0
                    }),
                    threshold: autoSend.getSupplierThreshold(extractedFields?.supplier || ocrResult?.supplier)
                }
            });

            // Determine status based on auto-send decision
            // Use OUT for AUTO_SEND, REVIEW for MANUAL_REVIEW
            const finalStatus = autoSendDecision.nextAction === 'READY_FOR_EXPORT' ? 'OUT' : 'REVIEW';

            // Determine review status based on confidence
            const matchConfidence = jobMatch?.match?.confidence || 0;
            let matchStatus = 'REVIEW';
            let matchType = jobMatch?.match?.matchType || 'NO_MATCH';

            if (matchConfidence >= 0.95) {
                matchStatus = 'HIGH_CONFIDENCE';
            } else if (matchConfidence >= 0.70) {
                matchStatus = 'MEDIUM_CONFIDENCE';
            } else {
                matchStatus = 'LOW_CONFIDENCE';
            }

            // Log match decision
            if (jobMatch && jobMatch.match) {
                audit.logMatch(attachmentId, {
                    jobId: jobMatch.match.jobId,
                    jobRef: jobMatch.match.jobRef,
                    confidence: jobMatch.match.confidence,
                    matchType: jobMatch.match.matchType,
                    candidates: jobMatch.candidates,
                    source: extractedFields ? 'EXTRACTOR' : 'OCR'
                });
                console.log(`Job match: ${jobMatch.match.jobRef}, confidence=${jobMatch.match.confidence}, type=${jobMatch.match.matchType}, status=${matchStatus}`);
            } else {
                audit.logMatch(attachmentId, {
                    jobId: null,
                    jobRef: null,
                    confidence: 0,
                    matchType: 'NO_MATCH',
                    candidates: [],
                    source: 'NONE'
                });
            }

            // 4. Auto-route based on classification and match
            const routeDecision = autoRoute.route({
                classification,
                match: jobMatch,
                sender: from
            });

            // Use auto-send decision for final status, fallback to routeDecision
            const finalRouteTo = finalStatus === 'OUT' ? routeDecision.routeTo : routeDecision.routeTo;

            // Update attachment status with routing decision and OCR data
            models.updateAttachmentStatus(attachmentId, finalRouteTo, {
                classificationConfidence: classification.confidence,
                // Match info from new match.findMatch() result structure
                matchedJobId: jobMatch?.match?.jobId || null,
                matchConfidence: jobMatch?.match?.confidence || 0,
                matchType: jobMatch?.match?.matchType || null,
                matchStatus: matchStatus,
                // Job ref from extracted fields or match result
                jobRef: extractedFields?.jobRef || ocrResult?.jobRef || jobMatch?.match?.jobRef || null,
                routingDecision: routeDecision.decisionType,
                routingReason: routeDecision.details?.reason,
                // Include extracted fields from extractor module
                supplier: extractedFields?.supplier || ocrResult?.supplier || null,
                vehicleReg: extractedFields?.vehicleReg || ocrResult?.vehicleReg || null,
                date: extractedFields?.date || ocrResult?.date || null,
                shipmentNumber: extractedFields?.shipmentNumber || ocrResult?.shipmentNumber || null,
                extractionConfidence: extractedFields?.confidence || ocrResult?.confidence || 0,
                // Auto-send decision metadata
                autoSendDecision: autoSendDecision.decision,
                autoSendReasonCode: autoSendDecision.reasonCode,
                autoSendReason: autoSendDecision.reason
            });

            audit.logRoute(attachmentId, finalRouteTo, {
                decisionType: routeDecision.decisionType,
                confidence: routeDecision.confidence,
                reason: routeDecision.details?.reason,
                classification: classification,
                match: jobMatch,
                autoSendDecision: autoSendDecision,
                extraction: extractedFields ? {
                    supplier: extractedFields.supplier,
                    jobRef: extractedFields.jobRef,
                    vehicleReg: extractedFields.vehicleReg,
                    date: extractedFields.date,
                    shipmentNumber: extractedFields.shipmentNumber,
                    confidence: extractedFields.confidence
                } : null
            });

            console.log(`Routed: ${finalRouteTo} (${routeDecision.decisionType}, autoSend=${autoSendDecision.decision}, confidence=${routeDecision.confidence})`);
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

// ============================================
// Health Check Endpoint (Phase 15 - Stability)
// ============================================
app.get('/api/health', (req, res) => {
    const uptime = Math.floor((Date.now() - stability.startTime) / 1000);
    const memUsage = process.memoryUsage();
    const memoryUsed = memUsage.heapUsed;
    const memoryTotal = memUsage.heapTotal;

    // Determine circuit state
    let circuitStatus = stability.circuitState;
    if (stability.circuitState === 'open') {
        const elapsed = Date.now() - stability.circuitOpenedAt;
        if (elapsed > stability.baseDelay * Math.pow(2, Math.min(stability.consecutiveFailures, 10))) {
            circuitStatus = 'half-open';
        }
    }

    // Determine overall status
    let status = 'healthy';
    if (!isReady) status = 'degraded';
    if (stability.circuitState === 'open' && stability.consecutiveFailures >= stability.maxFailures) {
        status = 'unhealthy';
    }

    res.json({
        status,
        timestamp: new Date().toISOString(),
        uptime,
        connected: isReady,
        service: 'whatsapp-pod-service',
        version: '1.0.0',
        memory: {
            heapUsed: memoryUsed,
            heapTotal: memoryTotal,
            unit: 'bytes'
        },
        circuit: {
            state: circuitStatus,
            consecutiveFailures: stability.consecutiveFailures,
            maxFailures: stability.maxFailures
        },
        pm2: {
            restartCount: stability.restartCount,
            lastError: stability.lastErrorTime
        }
    });
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

// Force-send endpoint - override auto-send threshold
app.post('/api/attachments/:id/force-send', (req, res) => {
    try {
        const { reason, overrideBy } = req.body;

        // Get current attachment
        const attachment = models.getAttachmentById(req.params.id);
        if (!attachment) return res.status(404).json({ error: 'Not found' });

        // Check if already in OUT status
        if (attachment.status === 'OUT') {
            return res.json({
                success: true,
                message: 'Already in OUT status',
                attachment
            });
        }

        // Create force-send decision
        const forceDecision = autoSend.shouldForceSend(
            attachment,
            { confidence: attachment.match_confidence || 0.5 },
            reason || 'Manual force-send override'
        );

        // Update status to OUT
        const result = models.updateAttachmentStatus(req.params.id, 'OUT', {
            autoSendDecision: forceDecision.decision,
            autoSendReasonCode: forceDecision.reasonCode,
            autoSendReason: forceDecision.reason
        });

        if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

        // Audit log
        audit.logReview(req.params.id, overrideBy || 'reviewer', 'force_send', {
            reason,
            overrideBy,
            decision: forceDecision
        });
        audit.logRoute(req.params.id, 'OUT', {
            reason: `Force send override: ${reason}`,
            decision: forceDecision
        });

        res.json({
            success: true,
            decision: forceDecision,
            attachment: models.getAttachmentById(req.params.id)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Auto-Send Configuration Endpoints
// ============================================

// Get auto-send configuration
app.get('/api/auto-send/config', (req, res) => {
    try {
        const summary = autoSend.getConfigSummary();
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reload auto-send configuration
app.post('/api/auto-send/reload', (req, res) => {
    try {
        const config = autoSend.reloadConfig();
        res.json({
            success: true,
            message: 'Configuration reloaded',
            config: autoSend.getConfigSummary()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Validate auto-send configuration
app.post('/api/auto-send/validate', (req, res) => {
    try {
        const configFile = req.query.path || path.join(__dirname, 'config', 'auto-send.json');
        const result = autoSend.validateConfig(configFile);

        if (result.valid) {
            res.json({ valid: true, message: 'Configuration is valid' });
        } else {
            res.status(400).json({ valid: false, errors: result.errors });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Simulate auto-send decision for an attachment
app.post('/api/auto-send/simulate', (req, res) => {
    try {
        const { attachmentId } = req.body;

        if (!attachmentId) {
            return res.status(400).json({ error: 'attachmentId is required' });
        }

        const attachment = models.getAttachmentById(attachmentId);
        if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

        // Get match info
        const matchResult = attachment.matched_job_id ? {
            found: true,
            confidence: attachment.match_confidence || 0.5,
            supplier: attachment.supplier
        } : {
            found: false,
            confidence: 0,
            supplier: attachment.supplier
        };

        const decision = autoSend.shouldAutoSend(attachment, matchResult);

        res.json({
            attachmentId,
            currentStatus: attachment.status,
            simulation: {
                overallConfidence: autoSend.calculateOverallConfidence({
                    classification: attachment.classification_confidence || 0,
                    extraction: attachment.extraction_confidence || 0,
                    matching: attachment.match_confidence || 0
                }),
                supplier: attachment.supplier,
                threshold: autoSend.getSupplierThreshold(attachment.supplier),
                decision
            }
        });
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

        // Random delay between messages to prevent bot detection (1-10 seconds)
        const randomDelay = Math.floor(Math.random() * 9000) + 1000;
        await new Promise(resolve => setTimeout(resolve, randomDelay));
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
    console.log('[SHUTDOWN] Received SIGINT - graceful shutdown...');
    try {
        if (client && client.pupPage) {
            await client.pupPage.close().catch(() => {});
        }
        if (client && client.pupBrowser) {
            await client.pupBrowser.close().catch(() => {});
        }
        if (client) {
            await client.destroy().catch(() => {});
        }
    } catch (e) {
        console.log('[SHUTDOWN] Cleanup error (non-critical):', e.message);
    }
    emailQueue.stopProcessor();
    process.exit(0);
});

// Also handle SIGTERM
process.on('SIGTERM', async () => {
    console.log('[SHUTDOWN] Received SIGTERM - graceful shutdown...');
    try {
        if (client && client.pupPage) {
            await client.pupPage.close().catch(() => {});
        }
        if (client && client.pupBrowser) {
            await client.pupBrowser.close().catch(() => {});
        }
        if (client) {
            await client.destroy().catch(() => {});
        }
    } catch (e) {
        console.log('[SHUTDOWN] Cleanup error (non-critical):', e.message);
    }
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

// Retention policies list
app.get('/api/retention/policies', (req, res) => {
    try {
        const policies = retention.getPolicies();
        res.json({ count: policies.length, policies });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get single retention policy
app.get('/api/retention/policies/:id', (req, res) => {
    try {
        const policy = retention.getPolicy(req.params.id);
        if (!policy) return res.status(404).json({ error: 'Policy not found' });
        res.json(policy);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update retention policy
app.put('/api/retention/policies/:id', (req, res) => {
    try {
        const policy = retention.setRule({ ...req.body, policy_id: req.params.id });
        res.json({ success: true, policy });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Retention stats
app.get('/api/retention/stats', (req, res) => {
    try {
        const stats = retention.getStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get retention status for an attachment
app.get('/api/attachments/:id/retention-status', (req, res) => {
    try {
        const attachment = models.getAttachmentById(req.params.id);
        if (!attachment) return res.status(404).json({ error: 'Not found' });

        const rule = retention.getRetentionExpiry(attachment);
        const isOnHold = legalHold.isProtected(req.params.id);

        res.json({
            attachment_id: req.params.id,
            created_at: attachment.created_at,
            status: attachment.status,
            retention: rule,
            is_on_hold: isOnHold,
            archive_eligible: rule.archive_eligible && !isOnHold,
            delete_eligible: rule.delete_eligible && !isOnHold
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get items eligible for archive
app.get('/api/retention/pending-archive', (req, res) => {
    try {
        const { limit = 100 } = req.query;
        const items = retention.getAttachmentsEligibleForArchive({ limit: parseInt(limit) });
        res.json({ count: items.length, items });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get items eligible for deletion
app.get('/api/retention/pending-delete', (req, res) => {
    try {
        const { limit = 100 } = req.query;
        const items = retention.getAttachmentsEligibleForDelete({ limit: parseInt(limit) });
        res.json({ count: items.length, items });
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

// Manually archive an attachment
app.post('/api/attachments/:id/archive', (req, res) => {
    try {
        const { archivedBy = 'api' } = req.body;
        const result = archive.archive(req.params.id, { archivedBy });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Force delete an attachment (skips retention check, requires admin)
app.post('/api/attachments/:id/delete', (req, res) => {
    try {
        const { deletedBy = 'api', reason = 'Manual deletion' } = req.body;
        const result = archive.hardDelete(req.params.id, { deletedBy, reason });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Soft delete (marks as pending delete)
app.post('/api/attachments/:id/soft-delete', (req, res) => {
    try {
        const { deletedBy = 'api', reason = null } = req.body;
        const result = archive.softDelete(req.params.id, { deletedBy, reason });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Undelete a soft-deleted attachment
app.post('/api/attachments/:id/undelete', (req, res) => {
    try {
        const { undeletedBy = 'api' } = req.body;
        const result = archive.undelete(req.params.id, { undeletedBy });
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
        const downloadInfo = evidence.recordDownload(req.params.bundleId);
        if (!fs.existsSync(downloadInfo.path)) {
            return res.status(404).json({ error: 'Bundle file not found' });
        }

        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${downloadInfo.filename}"`);
        res.setHeader('Content-Length', fs.statSync(downloadInfo.path).size);
        res.setHeader('X-Checksum-SHA256', downloadInfo.checksum);
        res.sendFile(downloadInfo.path);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete evidence bundle
app.delete('/api/evidence/:bundleId', (req, res) => {
    try {
        const bundle = evidence.getBundle(req.params.bundleId);
        if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

        // Remove file if exists
        if (fs.existsSync(bundle.archive_path)) {
            fs.unlinkSync(bundle.archive_path);
        }

        // Update status
        const db = require('./db').getDb();
        db.prepare("UPDATE evidence_bundles SET status = 'DELETED' WHERE id = ?").run(bundle.id);

        res.json({ success: true, bundle_id: req.params.bundleId, deleted_at: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Cleanup expired bundles
app.post('/api/evidence/cleanup', (req, res) => {
    try {
        const cleaned = evidence.cleanupExpiredBundles();
        res.json({ cleaned_up: cleaned, cleaned_at: new Date().toISOString() });
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
// R2 Storage Endpoints (Plan 07-02)
// ============================================

// GET /api/storage/upload-url
// Request: ?filename=abc.jpg&contentType=image/jpeg&category=pods
// Response: { uploadUrl: 'https://...', key: 'pods/2024-01-01/abc123.jpg', expiresIn: 900 }
app.get('/api/storage/upload-url', async (req, res) => {
    try {
        const { filename, contentType, category } = req.query;

        if (!filename) {
            return res.status(400).json({ error: 'filename is required' });
        }

        const mimeType = contentType || mimeTypes.getMimeType(filename);
        const storageCategory = category || 'pods';

        const result = await presignedUrls.getUploadUrl(
            presignedUrls.generateStorageKey(filename, storageCategory),
            mimeType
        );

        res.json({
            uploadUrl: result.uploadUrl,
            key: result.key,
            expiresIn: result.expiresIn,
        });
    } catch (error) {
        console.error('[Storage] Upload URL generation failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/storage/download-url
// Request: ?key=pods/2024-01-01/abc123.jpg&expiresIn=3600
// Response: { downloadUrl: 'https://...', key: '...', expiresIn: 3600 }
app.get('/api/storage/download-url', async (req, res) => {
    try {
        const { key, expiresIn } = req.query;

        if (!key) {
            return res.status(400).json({ error: 'key is required' });
        }

        const result = await presignedUrls.getDownloadUrl(key, parseInt(expiresIn) || undefined);

        res.json({
            downloadUrl: result.downloadUrl,
            key: result.key,
            expiresIn: result.expiresIn,
        });
    } catch (error) {
        console.error('[Storage] Download URL generation failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/storage/public-url/:key(*)
// Returns public (unsigned) URL if configured
app.get('/api/storage/public-url/:key(*)', async (req, res) => {
    try {
        const { key } = req.params;
        const url = presignedUrls.getPublicUrl(key);

        if (!url) {
            return res.status(404).json({
                error: 'Public URL not configured',
                message: 'R2_PUBLIC_URL environment variable is not set'
            });
        }

        res.json({ url });
    } catch (error) {
        console.error('[Storage] Public URL generation failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/storage/upload-and-download-urls
// Get both URLs in single request
// Request: ?filename=abc.jpg&contentType=image/jpeg
// Response: { uploadUrl, downloadUrl, key, expiresIn }
app.get('/api/storage/upload-and-download-urls', async (req, res) => {
    try {
        const { filename, contentType, category } = req.query;

        if (!filename) {
            return res.status(400).json({ error: 'filename is required' });
        }

        const mimeType = contentType || mimeTypes.getMimeType(filename);
        const storageCategory = category || 'pods';

        const result = await presignedUrls.getUploadAndDownloadUrls(
            filename,
            mimeType,
            storageCategory
        );

        res.json(result);
    } catch (error) {
        console.error('[Storage] Combined URL generation failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/storage/webhook
// R2 Worker/External service calls this after successful upload
app.post('/api/storage/webhook', async (req, res) => {
    try {
        const { key, size, contentType, metadata } = req.body;

        if (!key) {
            return res.status(400).json({ error: 'key is required' });
        }

        console.log(`[Storage] Webhook received for: ${key}`);

        // Log webhook event
        audit.log({
            action: 'R2_UPLOAD_WEBHOOK',
            details: {
                key,
                size,
                contentType,
                metadata,
                receivedAt: new Date().toISOString()
            }
        });

        // Return acknowledgment
        res.json({
            received: true,
            key,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[Storage] Webhook processing failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/storage/status
// Get storage configuration and status
app.get('/api/storage/status', async (req, res) => {
    try {
        const storageStatus = await storage.getStorageStatus();

        res.json({
            configured: storageStatus.r2Configured,
            r2Available: storageStatus.r2Available,
            bucket: storageStatus.r2Bucket,
            publicUrlConfigured: storageStatus.r2PublicUrlConfigured,
            localStorageBase: storageStatus.localStorageBase,
            uploadUrlExpiry: presignedUrls.UPLOAD_URL_EXPIRY,
            downloadUrlExpiry: presignedUrls.DOWNLOAD_URL_EXPIRY,
        });
    } catch (error) {
        console.error('[Storage] Status check failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/storage/mime-type/:filename
// Get MIME type for a filename
app.get('/api/storage/mime-type/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        const mimeType = mimeTypes.getMimeType(filename);
        const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

        res.json({
            filename,
            mimeType,
            extension,
            isImage: mimeTypes.isImage(mimeType),
            isDocument: mimeTypes.isDocument(mimeType),
            isValidPodType: mimeTypes.isValidPodType(mimeType),
        });
    } catch (error) {
        console.error('[Storage] MIME type lookup failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// End R2 Storage Endpoints
// ============================================

// ============================================
// Phase 5: Start Background Services
// ============================================

// Start scheduled jobs
scheduler.startScheduler();

// Email queue processor (stub - no interval needed)
const processorInterval = null;
const POLL_INTERVAL = 30000;

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
// Process Monitoring (Phase 15 - Stability)
// ============================================
const MONITOR_INTERVAL = 60000; // 1 minute

const processMonitor = setInterval(() => {
    const memUsage = process.memoryUsage();
    const uptime = Math.floor((Date.now() - stability.startTime) / 1000);
    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);

    // Log monitoring data
    console.log(`[MONITOR] Uptime: ${uptime}s, Memory: ${memMB}MB, Connected: ${isReady}, Circuit: ${stability.circuitState}`);

    // Track memory for trend analysis
    stability.memoryLogs.push({
        timestamp: Date.now(),
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal
    });

    // Keep only last 100 entries
    if (stability.memoryLogs.length > 100) {
        stability.memoryLogs.shift();
    }

    // Warn if memory is getting high
    if (memMB > 150) {
        console.log(`[WARN] High memory usage: ${memMB}MB - consider restart`);
    }
}, MONITOR_INTERVAL);

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
