/**
 * POD Classification Module
 * Uses OpenAI GPT-4o-mini vision API to classify images as POD or NON_POD
 */

const OpenAI = require('openai');

// Classification categories
const NON_POD_TYPES = [
    'selfie',
    'vehicle_exterior',
    'scenery',
    'screenshot',
    'food',
    'animals',
    'blurry',
    'other'
];

const POD_TYPES = [
    'delivery_document',
    'delivery_ticket',
    'delivery_docket',
    'delivery_receipt',
    'signed_form',
    'proof_of_delivery'
];

// Classification prompt based on pod_extractor_implementation.py
const CLASSIFICATION_PROMPT = `Analyze this image and determine if it is a delivery document (POD/ticket/docket).

FIRST: Determine if this is a genuine delivery document.
If this is ANY of the following, it is NOT a POD:
- Selfie or photo of a person
- Photo of a vehicle (truck, car, trailer exterior)
- Scenery, landscape, or building exterior
- Screenshot of a conversation or app
- Photo of food, animals, or personal items
- Blurry or unreadable image
- Any image that is NOT a printed/digital delivery ticket or docket

For NON-POD images, return JSON like:
{"type": "NON_POD", "imageType": "describe what it is", "confidence": "high|medium|low", "isPOD": false}

ONLY if this IS a delivery document, proceed with POD classification:
- POD if: delivery document, ticket, docket, receipt, signed form, proof of delivery
- Look for: company logos, delivery notes, signatures, dates, reference numbers

Return ONLY valid JSON:
{
    "type": "POD" or "NON_POD",
    "imageType": "specific type (delivery_ticket/screenshot/selfie/etc)",
    "confidence": "high|medium|low",
    "isPOD": true/false,
    "reason": "brief explanation of classification"
}`;

// Global OpenAI client (lazy initialization)
let openaiClient = null;
let isInitialized = false;

/**
 * Initialize the classification module with OpenAI API client
 * @param {Object} options - Configuration options
 * @param {string} options.apiKey - OpenAI API key (defaults to process.env.OPENAI_API_KEY)
 */
function init(options = {}) {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) {
        throw new Error('OpenAI API key required. Set OPENAI_API_KEY environment variable or pass apiKey to init().');
    }

    openaiClient = new OpenAI({ apiKey });
    isInitialized = true;

    console.log('Classification module initialized with OpenAI');
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
 * @param {string} mimeType - MIME type of the image
 * @returns {string} Data URL
 */
function bufferToDataUrl(buffer, mimeType) {
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
}

/**
 * Classify an image as POD or NON_POD using OpenAI vision
 * @param {Buffer} imageBuffer - Image buffer
 * @param {string} mimeType - MIME type (e.g., 'image/jpeg', 'image/png')
 * @param {Object} options - Classification options
 * @returns {Promise<Object>} Classification result
 */
async function classify(imageBuffer, mimeType, options = {}) {
    // Initialize if not already done
    const client = getClient();

    try {
        const dataUrl = bufferToDataUrl(imageBuffer, mimeType);

        const response = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are a document analysis expert. Return ONLY valid JSON, no markdown or additional text.'
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: CLASSIFICATION_PROMPT
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
            max_tokens: 500,
            temperature: 0.1
        });

        const responseText = response.choices[0].message.content;
        const result = parseJsonResponse(responseText);

        // Normalize result
        const normalized = normalizeResult(result);

        return {
            type: normalized.isPOD ? 'POD' : 'NON_POD',
            imageType: normalized.imageType || 'unknown',
            confidence: normalized.confidence,
            isPOD: normalized.isPOD,
            reason: normalized.reason || null,
            raw: result
        };

    } catch (error) {
        console.error('Classification error:', error.message);

        // Return error result instead of throwing
        return {
            type: 'UNKNOWN',
            imageType: 'error',
            confidence: 0.0,
            isPOD: null,
            reason: `Classification failed: ${error.message}`,
            error: error.message
        };
    }
}

/**
 * Classify with image path (alternative to buffer)
 * @param {string} imagePath - Path to image file
 * @param {string} mimeType - MIME type
 * @param {Object} options - Options
 * @returns {Promise<Object>} Classification result
 */
async function classifyFromPath(imagePath, mimeType, options = {}) {
    const fs = require('fs');
    const buffer = fs.readFileSync(imagePath);
    return classify(buffer, mimeType, options);
}

/**
 * Parse JSON from OpenAI response (handles markdown wrapping)
 * @param {string} responseText - Raw response text
 * @returns {Object} Parsed JSON
 */
function parseJsonResponse(responseText) {
    // Clean markdown code blocks
    let cleaned = responseText.trim();

    if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    // Find JSON object in response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        cleaned = jsonMatch[0];
    }

    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // Try to extract partial data
        return {
            type: 'UNKNOWN',
            imageType: 'parse_error',
            confidence: 0.0,
            isPOD: null,
            reason: 'Failed to parse response',
            parseError: e.message
        };
    }
}

/**
 * Normalize classification result to consistent format
 * @param {Object} result - Raw result from OpenAI
 * @returns {Object} Normalized result
 */
function normalizeResult(result) {
    // Handle various confidence formats
    let confidence = 0.5;

    if (typeof result.confidence === 'string') {
        const confMap = {
            'high': 0.9,
            'medium': 0.6,
            'low': 0.3
        };
        confidence = confMap[result.confidence.toLowerCase()] || 0.5;
    } else if (typeof result.confidence === 'number') {
        confidence = Math.max(0, Math.min(1, result.confidence));
    }

    // Determine isPOD
    let isPOD = result.isPOD;

    // Fall back to type if isPOD not explicitly set
    if (isPOD === undefined || isPOD === null) {
        isPOD = POD_TYPES.some(pt =>
            result.type?.toLowerCase().includes(pt) ||
            result.imageType?.toLowerCase().includes(pt)
        ) && !NON_POD_TYPES.some(npt =>
            result.type?.toLowerCase().includes(npt) ||
            result.imageType?.toLowerCase().includes(npt)
        );
    }

    return {
        type: result.type || 'UNKNOWN',
        imageType: result.imageType || 'unknown',
        confidence,
        isPOD,
        reason: result.reason || null
    };
}

/**
 * Batch classify multiple images
 * @param {Array<{buffer: Buffer, mimeType: string}>} images - Array of images
 * @param {Object} options - Options
 * @returns {Promise<Array<Object>>} Array of classification results
 */
async function classifyBatch(images, options = {}) {
    const results = [];

    for (const image of images) {
        const result = await classify(image.buffer, image.mimeType, options);
        results.push(result);

        // Rate limiting - small delay between requests
        if (images.indexOf(image) < images.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    return results;
}

/**
 * Quick classification for testing (uses placeholder if not initialized)
 * @param {Object} metadata - Image metadata
 * @returns {Object} Classification result
 */
function quickClassify(metadata) {
    // Fallback for testing without API calls
    return {
        type: 'POD',
        imageType: 'unknown',
        confidence: 0.5,
        isPOD: true,
        reason: 'Quick classification (no API call)',
        quick: true
    };
}

// Stub function for image dimensions (referenced in service.js)
function getImageDimensions(imagePath) {
    const fs = require('fs');
    const path = require('path');

    // Simple placeholder - actual implementation would use sharp or similar
    return { width: 0, height: 0 };
}

module.exports = {
    init,
    isReady,
    classify,
    classifyFromPath,
    classifyBatch,
    quickClassify,
    getImageDimensions,
    NON_POD_TYPES,
    POD_TYPES
};
