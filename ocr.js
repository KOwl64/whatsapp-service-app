/**
 * OCR Module
 * Uses OpenAI GPT-4o-mini vision API to extract text from images
 */

const OpenAI = require('openai');

// Global OpenAI client (lazy initialization)
let openaiClient = null;
let isInitialized = false;

// Prompt for extracting all visible text
const EXTRACT_TEXT_PROMPT = `Extract ALL visible text from this image. Return the text exactly as it appears, preserving formatting where possible. If no text is visible, return an empty string.`;

// Prompt for structured field extraction (from pod_extractor_implementation.py)
const EXTRACT_STRUCTURED_PROMPT = `Analyze this image and extract structured delivery information.

For ALL images, identify:
1. SUPPLIER/COMPANY: Look for company names, logos, or document headers
   - Known suppliers: CPI Euromix, Ecocem, Tarmac, Heidelberg, Cemex, Masaveu
2. JOB REFERENCE: Look for order numbers, docket numbers, reference numbers
   - Patterns: "Order No.", "Dkt No.", "Docket", "Reference", "Job"
3. VEHICLE REGISTRATION: Look for UK vehicle registration numbers
   - Format: XX00XXX (e.g., GV66XRO, DK18ABC)
4. DATE: Look for delivery dates
   - Formats: DD.MM.YY, DD/MM/YYYY, YYYY-MM-DD
5. SHIPMENT NUMBER: Secondary reference for Tarmac-style documents

Return ONLY valid JSON:
{
    "supplier": "detected company name or null",
    "jobRef": "order/docket/reference number or null",
    "vehicleReg": "UK vehicle registration or null",
    "date": "date string as found or null",
    "shipmentNumber": "shipment/waybill number or null",
    "confidence": 0.0-1.0,
    "rawText": "extracted text for debugging"
}`;

/**
 * Initialize the OCR module with OpenAI API client
 * @param {Object} options - Configuration options
 * @param {string} options.apiKey - OpenAI API key
 * @param {Object} options.client - Pre-configured OpenAI client (reuses if provided)
 */
function init(options = {}) {
    if (options.client) {
        openaiClient = options.client;
        isInitialized = true;
        console.log('OCR module initialized with provided client');
        return true;
    }

    const apiKey = options.apiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) {
        throw new Error('OpenAI API key required. Set OPENAI_API_KEY environment variable or pass apiKey to init().');
    }

    openaiClient = new OpenAI({ apiKey });
    isInitialized = true;

    console.log('OCR module initialized with OpenAI');
    return true;
}

/**
 * Check if module is initialized
 */
function isReady() {
    return isInitialized && openaiClient !== null;
}

/**
 * Get or create OpenAI client
 */
function getClient() {
    if (!isInitialized) {
        init();
    }
    return openaiClient;
}

/**
 * Convert buffer to base64 data URL
 * @param {Buffer} buffer - Image buffer
 * @param {string} mimeType - MIME type
 * @returns {string} Data URL
 */
function bufferToDataUrl(buffer, mimeType) {
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
}

/**
 * Extract all visible text from an image
 * @param {Buffer} imageBuffer - Image buffer
 * @param {string} mimeType - MIME type
 * @param {Object} options - Options
 * @returns {Promise<Object>} Result with text and confidence
 */
async function extractText(imageBuffer, mimeType, options = {}) {
    const client = getClient();

    const startTime = Date.now();

    try {
        const dataUrl = bufferToDataUrl(imageBuffer, mimeType);

        const response = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are an OCR system. Extract and return ONLY the visible text from the image. No explanations.'
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: EXTRACT_TEXT_PROMPT
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: dataUrl
                            }
                        }
                    ]
                }
            ],
            max_tokens: 4000,
            temperature: 0.1
        });

        const duration = Date.now() - startTime;
        const text = response.choices[0].message.content.trim();

        // Estimate confidence based on response length and model behavior
        const confidence = text.length > 0 ? 0.85 : 0.5;

        return {
            success: true,
            text,
            confidence,
            wordCount: text.split(/\s+/).filter(w => w.length > 0).length,
            duration,
            raw: text
        };

    } catch (error) {
        console.error('OCR extraction error:', error.message);
        return {
            success: false,
            text: '',
            confidence: 0.0,
            wordCount: 0,
            duration: Date.now() - startTime,
            error: error.message
        };
    }
}

/**
 * Extract text from image file path
 * @param {string} imagePath - Path to image
 * @param {string} mimeType - MIME type
 * @param {Object} options - Options
 * @returns {Promise<Object>} Extraction result
 */
async function extractTextFromPath(imagePath, mimeType, options = {}) {
    const fs = require('fs');
    const buffer = fs.readFileSync(imagePath);
    return extractText(buffer, mimeType, options);
}

/**
 * Extract structured fields from image
 * @param {Buffer} imageBuffer - Image buffer
 * @param {string} mimeType - MIME type
 * @param {Object} options - Options
 * @returns {Promise<Object>} Structured extraction result
 */
async function extractStructured(imageBuffer, mimeType, options = {}) {
    const client = getClient();

    const startTime = Date.now();

    try {
        const dataUrl = bufferToDataUrl(imageBuffer, mimeType);

        const response = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are a document analysis expert. Return ONLY valid JSON matching the specified schema.'
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: EXTRACT_STRUCTURED_PROMPT
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: dataUrl
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1000,
            temperature: 0.1
        });

        const duration = Date.now() - startTime;
        const responseText = response.choices[0].message.content;

        // Parse JSON response
        const data = parseJsonResponse(responseText);

        return {
            success: true,
            supplier: data.supplier || null,
            jobRef: data.jobRef || null,
            vehicleReg: data.vehicleReg || null,
            date: data.date || null,
            shipmentNumber: data.shipmentNumber || null,
            confidence: data.confidence || 0.5,
            rawText: data.rawText || '',
            duration,
            raw: data
        };

    } catch (error) {
        console.error('Structured extraction error:', error.message);
        return {
            success: false,
            supplier: null,
            jobRef: null,
            vehicleReg: null,
            date: null,
            shipmentNumber: null,
            confidence: 0.0,
            rawText: '',
            duration: Date.now() - startTime,
            error: error.message
        };
    }
}

/**
 * Extract structured fields from image path
 * @param {string} imagePath - Path to image
 * @param {string} mimeType - MIME type
 * @param {Object} options - Options
 * @returns {Promise<Object>} Structured extraction result
 */
async function extractStructuredFromPath(imagePath, mimeType, options = {}) {
    const fs = require('fs');
    const buffer = fs.readFileSync(imagePath);
    return extractStructured(buffer, mimeType, options);
}

/**
 * Parse JSON from OpenAI response (handles markdown wrapping)
 * @param {string} responseText - Raw response text
 * @returns {Object} Parsed JSON
 */
function parseJsonResponse(responseText) {
    let cleaned = responseText.trim();

    // Clean markdown code blocks
    if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    // Find JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        cleaned = jsonMatch[0];
    }

    try {
        return JSON.parse(cleaned);
    } catch (e) {
        return {
            error: 'Failed to parse response',
            parseError: e.message,
            raw: responseText.substring(0, 200)
        };
    }
}

/**
 * Batch extract text from multiple images
 * @param {Array<{buffer: Buffer, mimeType: string}>} images - Array of images
 * @param {Object} options - Options
 * @returns {Promise<Array<Object>>} Array of results
 */
async function extractTextBatch(images, options = {}) {
    const results = [];

    for (const image of images) {
        const result = await extractText(image.buffer, image.mimeType, options);
        results.push(result);

        // Rate limiting
        if (images.indexOf(image) < images.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    return results;
}

/**
 * Batch extract structured fields from multiple images
 * @param {Array<{buffer: Buffer, mimeType: string}>} images - Array of images
 * @param {Object} options - Options
 * @returns {Promise<Array<Object>>} Array of results
 */
async function extractStructuredBatch(images, options = {}) {
    const results = [];

    for (const image of images) {
        const result = await extractStructured(image.buffer, image.mimeType, options);
        results.push(result);

        // Rate limiting
        if (images.indexOf(image) < images.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    return results;
}

/**
 * Utility: Detect vehicle registration in text
 * @param {string} text - Text to search
 * @returns {Array<string>} Array of found registrations
 */
function detectVehicleRegs(text) {
    const regPattern = /[A-Z]{1,2}\d{2,4}[A-Z]{1,3}/g;
    return text.match(regPattern) || [];
}

/**
 * Utility: Detect dates in text
 * @param {string} text - Text to search
 * @returns {Array<string>} Array of found dates
 */
function detectDates(text) {
    const patterns = [
        /\d{2}\.\d{2}\.\d{2,4}/g,   // DD.MM.YY or DD.MM.YYYY
        /\d{2}\/\d{2}\/\d{2,4}/g,   // DD/MM/YY or DD/MM/YYYY
        /\d{4}-\d{2}-\d{2}/g         // YYYY-MM-DD
    ];

    const dates = [];
    patterns.forEach(pattern => {
        const matches = text.match(pattern);
        if (matches) {
            dates.push(...matches);
        }
    });

    return [...new Set(dates)];
}

/**
 * Utility: Detect job references in text
 * @param {string} text - Text to search
 * @returns {Array<string>} Array of found references
 */
function detectJobRefs(text) {
    const patterns = [
        /Order\s*[Nn]o\.?\s*([A-Z0-9-]+)/gi,
        /[Dd]kt\.?\s*[Nn]o\.?\s*([A-Z0-9-]+)/gi,
        /[Dd]ocket\s*[Nn]o\.?\s*([A-Z0-9-]+)/gi,
        /[Rr]eference\s*[Nn]o\.?\s*([A-Z0-9-]+)/gi,
        /Job\s*[Rr]ef\.?\s*([A-Z0-9-]+)/gi,
        /([A-Z0-9]{5,12})/g  // Generic 5-12 char alphanumeric
    ];

    const refs = [];
    patterns.forEach((pattern, index) => {
        if (index < 5) {
            const matches = text.matchAll(pattern);
            for (const match of matches) {
                if (match[1]) {
                    refs.push(match[1].trim());
                }
            }
        }
    });

    return [...new Set(refs)];
}

module.exports = {
    init,
    isReady,
    extractText,
    extractTextFromPath,
    extractStructured,
    extractStructuredFromPath,
    extractTextBatch,
    extractStructuredBatch,
    detectVehicleRegs,
    detectDates,
    detectJobRefs
};
