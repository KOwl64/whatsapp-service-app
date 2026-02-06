/**
 * Field Extraction Module
 * Parses OCR text to extract structured fields from POD documents
 * Supports supplier-specific patterns for job reference, vehicle registration, date, and supplier identification
 */

const SUPPLIERS = {
    CPI_EUROMIX: {
        names: ['cpi euromix', 'cpi euro mix', 'cpi euix'],
        docketPattern: /Order\s*No\.?\s*[:.]?\s*([A-Z0-9-]+)/i,
        field: 'docketNumber'
    },
    ECOCEM: {
        names: ['ecocem'],
        docketPattern: /Dkt\s*No\.?\s*[:.]?\s*([A-Z0-9-]+)/i,
        field: 'docketNumber'
    },
    TARMAC: {
        names: ['tarmac'],
        docketPattern: /(?:Docket|Docket\s*No\.?|Ref\.?)\s*[:.]?\s*([A-Z0-9-]+)/i,
        shipmentPattern: /(?:Shipment|No\.?|Number)\s*[:.]?\s*([A-Z0-9-]+)/i,
        barcodePattern: /\b([0-9]{13})\b/,
        field: 'docketNumber'
    },
    HEIDELBERG: {
        names: ['heidelberg'],
        docketPattern: /(?:Ticket|Conveyance)\s*(?:No\.?|Number|#)?\s*[:.]?\s*([A-Z0-9-]+)/i,
        field: 'ticketNumber'
    },
    CEMEX: {
        names: ['cemex'],
        docketPattern: /(?:Delivery\s*Receipt|Docket|Reference)\s*(?:No\.?|Number|#)?\s*[:.]?\s*([A-Z0-9-]+)/i,
        field: 'deliveryReceipt'
    },
    MASAVEU: {
        names: ['masaveu'],
        docketPattern: /(?:Delivery\s*Ticket|Ticket)\s*(?:No\.?|Number|#)?\s*[:.]?\s*([A-Z0-9-]+)/i,
        field: 'deliveryTicket'
    },
    SMARTFLOW: {
        names: ['smartflow'],
        docketPattern: /(?:Delivery\s*Reference|Ref\.?)\s*[:.]?\s*([A-Z0-9-]+)/i,
        field: 'deliveryReference'
    }
};

// UK Vehicle Registration patterns (current and new formats)
const VEHICLE_REG_PATTERNS = [
    /\b([A-Z]{2}\s*[0-9]{2}\s*[A-Z]{3})\b/i,           // e.g., "GV66 XRO", "DK18 ABC"
    /\b([A-Z]{1,2}\s*[0-9]{1,4}\s*[A-Z]{1,3})\b/i,      // Older formats
    /\b([A-Z]{3}\s*[0-9]{1,4}\s*[A-Z]{0,3})\b/i,        // Prefix format
    /\b([0-9]{1,4}\s*[A-Z]{3}\s*[0-9]{1,4})\b/i,        // Suffix format
];

// Date patterns in various formats
const DATE_PATTERNS = [
    /\b(\d{1,2})[\.\/-](\d{1,2})[\.\/-](\d{2,4})\b/,    // DD.MM.YY or DD/MM/YYYY
    /\b(\d{4})[\.\/-](\d{1,2})[\.\/-](\d{1,2})\b/,      // YYYY-MM-DD
    /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{2,4})\b/i, // DD Mon YYYY
];

// Common job reference patterns
const JOB_REF_PATTERNS = [
    /(?:Order|Job|Reference|Ref\.?|Job\s*Ref\.?)\s*No\.?\s*[:.]?\s*([A-Z0-9\-\/]+)/i,
    /(?:Job|Order|Reference)\s*[:.]?\s*([A-Z0-9\-\/]+)/i,
    /\b([A-Z]{1,3}[-\/]?[0-9]{4,8}[-\/]?[A-Z0-9]*)\b/,  // Common job ref format
];

/**
 * Initialize the extractor module
 * @param {Object} config - Configuration options
 */
function init(config) {
    // Placeholder for any initialization (e.g., loading custom patterns)
    return true;
}

/**
 * Extract structured fields from OCR text
 * @param {string} text - Raw OCR text
 * @param {Object} options - Extraction options
 * @returns {Object} Extracted fields with confidence score
 */
function extract(text, options = {}) {
    if (!text || typeof text !== 'string') {
        return createEmptyResult();
    }

    const result = {
        supplier: null,
        supplierConfidence: 0,
        jobRef: null,
        jobRefConfidence: 0,
        vehicleReg: null,
        vehicleRegConfidence: 0,
        date: null,
        dateConfidence: 0,
        shipmentNumber: null,
        shipmentNumberConfidence: 0,
        confidence: 0,
        rawText: text,
        extractedAt: new Date().toISOString()
    };

    // Extract supplier
    const supplierResult = extractSupplier(text);
    result.supplier = supplierResult.supplier;
    result.supplierConfidence = supplierResult.confidence;

    // Extract job reference
    const jobRefResult = extractJobRef(text, result.supplier);
    result.jobRef = jobRefResult.value;
    result.jobRefConfidence = jobRefResult.confidence;

    // Extract vehicle registration
    const vehicleRegResult = extractVehicleReg(text);
    result.vehicleReg = vehicleRegResult.value;
    result.vehicleRegConfidence = vehicleRegResult.confidence;

    // Extract date
    const dateResult = extractDate(text);
    result.date = dateResult.value;
    result.dateConfidence = dateResult.confidence;

    // Extract shipment number (especially for Tarmac)
    const shipmentResult = extractShipmentNumber(text, result.supplier);
    result.shipmentNumber = shipmentResult.value;
    result.shipmentNumberConfidence = shipmentResult.confidence;

    // Calculate overall confidence
    result.confidence = calculateOverallConfidence(result);

    return result;
}

/**
 * Extract supplier from text
 */
function extractSupplier(text) {
    const lowerText = text.toLowerCase();

    for (const [supplierKey, supplierInfo] of Object.entries(SUPPLIERS)) {
        for (const name of supplierInfo.names) {
            if (lowerText.includes(name)) {
                return {
                    supplier: supplierKey,
                    confidence: 0.9
                };
            }
        }
    }

    // Check for Cemex brand anywhere (per Python implementation)
    if (lowerText.includes('cemex')) {
        return {
            supplier: 'CEMEX',
            confidence: 1.0  // Cemex detection is definitive
        };
    }

    return { supplier: null, confidence: 0 };
}

/**
 * Extract job reference based on supplier patterns
 */
function extractJobRef(text, supplier) {
    const lowerText = text.toLowerCase();

    // Try supplier-specific pattern first
    if (supplier && SUPPLIERS[supplier]) {
        const pattern = SUPPLIERS[supplier].docketPattern;
        const match = text.match(pattern);
        if (match) {
            return { value: match[1], confidence: 0.95 };
        }
    }

    // Try generic job reference patterns
    for (const pattern of JOB_REF_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            const value = match[1];
            // Validate it's not a date or vehicle reg
            if (value && value.length >= 5 && value.length <= 20) {
                return { value, confidence: 0.8 };
            }
        }
    }

    return { value: null, confidence: 0 };
}

/**
 * Extract vehicle registration
 */
function extractVehicleReg(text) {
    for (const pattern of VEHICLE_REG_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            // Normalize the registration (remove spaces for consistency)
            const normalized = match[1].replace(/\s+/g, '').toUpperCase();
            // Validate format
            if (isValidVehicleReg(normalized)) {
                return { value: normalized, confidence: 0.9 };
            }
        }
    }
    return { value: null, confidence: 0 };
}

/**
 * Validate UK vehicle registration format
 */
function isValidVehicleReg(reg) {
    // Current format: 2 letters + 2 numbers + 3 letters (e.g., GV66XRO)
    const currentFormat = /^[A-Z]{2}\d{2}[A-Z]{3}$/i;
    // Prefix format: 1-3 letters + 1-4 numbers + up to 3 letters
    const prefixFormat = /^[A-Z]{1,3}\d{1,4}[A-Z]{0,3}$/i;
    // Suffix format: 1-4 numbers + 1-3 letters
    const suffixFormat = /^\d{1,4}[A-Z]{1,3}$/i;

    return currentFormat.test(reg) || prefixFormat.test(reg) || suffixFormat.test(reg);
}

/**
 * Extract date from text
 */
function extractDate(text) {
    // Try DD.MM.YY or DD/MM/YYYY first
    let match = text.match(DATE_PATTERNS[0]);
    if (match) {
        const day = match[1].padStart(2, '0');
        const month = match[2].padStart(2, '0');
        let year = match[3];
        if (year.length === 2) {
            year = '20' + year;  // Assume 2000s
        }
        return { value: `${year}-${month}-${day}`, confidence: 0.9 };
    }

    // Try YYYY-MM-DD
    match = text.match(DATE_PATTERNS[1]);
    if (match) {
        return { value: `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, confidence: 0.9 };
    }

    // Try DD Mon YYYY
    match = text.match(DATE_PATTERNS[2]);
    if (match) {
        const day = match[1].padStart(2, '0');
        const month = parseMonth(match[2]);
        const year = match[3].length === 2 ? '20' + match[3] : match[3];
        if (month) {
            return { value: `${year}-${month}-${day}`, confidence: 0.85 };
        }
    }

    return { value: null, confidence: 0 };
}

/**
 * Parse month abbreviation
 */
function parseMonth(monthStr) {
    const months = {
        'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
        'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
        'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
    };
    return months[monthStr.toLowerCase()] || null;
}

/**
 * Extract shipment number (especially for Tarmac)
 */
function extractShipmentNumber(text, supplier) {
    // Tarmac specific: look for Shipment number
    if (supplier === 'TARMAC') {
        const pattern = /(?:Shipment|No\.?|Number)\s*[:.]?\s*([A-Z0-9-]+)/i;
        const match = text.match(pattern);
        if (match) {
            return { value: match[1], confidence: 0.9 };
        }

        // Try barcode pattern for Tarmac (13-digit)
        const barcodeMatch = text.match(/\b([0-9]{13})\b/);
        if (barcodeMatch) {
            return { value: barcodeMatch[1], confidence: 0.95 };
        }
    }

    return { value: null, confidence: 0 };
}

/**
 * Calculate overall confidence score
 */
function calculateOverallConfidence(result) {
    const weights = {
        supplier: 0.2,
        jobRef: 0.3,
        vehicleReg: 0.2,
        date: 0.15,
        shipmentNumber: 0.15
    };

    let weightedSum = 0;
    let totalWeight = 0;

    if (result.supplier) {
        weightedSum += result.supplierConfidence * weights.supplier;
        totalWeight += weights.supplier;
    }
    if (result.jobRef) {
        weightedSum += result.jobRefConfidence * weights.jobRef;
        totalWeight += weights.jobRef;
    }
    if (result.vehicleReg) {
        weightedSum += result.vehicleRegConfidence * weights.vehicleReg;
        totalWeight += weights.vehicleReg;
    }
    if (result.date) {
        weightedSum += result.dateConfidence * weights.date;
        totalWeight += weights.date;
    }
    if (result.shipmentNumber) {
        weightedSum += result.shipmentNumberConfidence * weights.shipmentNumber;
        totalWeight += weights.shipmentNumber;
    }

    // If we found nothing, return 0
    if (totalWeight === 0) return 0;

    // Normalize to 0-1 range
    return weightedSum / totalWeight;
}

/**
 * Create empty result object
 */
function createEmptyResult() {
    return {
        supplier: null,
        supplierConfidence: 0,
        jobRef: null,
        jobRefConfidence: 0,
        vehicleReg: null,
        vehicleRegConfidence: 0,
        date: null,
        dateConfidence: 0,
        shipmentNumber: null,
        shipmentNumberConfidence: 0,
        confidence: 0,
        rawText: null,
        extractedAt: new Date().toISOString()
    };
}

/**
 * Get quality score for extracted fields (used by service.js)
 * @param {Object} extractedFields - Extracted fields from OCR
 * @returns {number} Quality score 0-1
 */
function getQualityScore(extractedFields) {
    if (!extractedFields) return 0;

    let score = 0;
    let count = 0;

    if (extractedFields.jobRefs && extractedFields.jobRefs.length > 0) {
        score += 0.4;
        count++;
    }
    if (extractedFields.vehicleRegs && extractedFields.vehicleRegs.length > 0) {
        score += 0.3;
        count++;
    }
    if (extractedFields.dates && extractedFields.dates.length > 0) {
        score += 0.2;
        count++;
    }
    if (extractedFields.phones && extractedFields.phones.length > 0) {
        score += 0.1;
        count++;
    }

    return count > 0 ? score : 0;
}

/**
 * Batch extract from multiple text sources
 * @param {Array<string>} texts - Array of OCR text strings
 * @returns {Array<Object>} Array of extraction results
 */
function extractBatch(texts) {
    return texts.map(text => extract(text));
}

module.exports = {
    init,
    extract,
    extractBatch,
    getQualityScore,
    // Export patterns for testing
    SUPPLIERS,
    VEHICLE_REG_PATTERNS,
    DATE_PATTERNS,
    JOB_REF_PATTERNS
};
