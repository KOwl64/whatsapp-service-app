/**
 * Auto-Send Rule Engine
 * Evaluates confidence thresholds to determine if PODs should auto-send or require manual review
 */

const fs = require('fs');
const path = require('path');

// Configuration schema
let config = null;
let configPath = null;

/**
 * Decision types for auto-send evaluation
 */
const DecisionType = {
    AUTO_SEND: 'AUTO_SEND',
    MANUAL_REVIEW: 'MANUAL_REVIEW',
    FORCE_SEND: 'FORCE_SEND',
    REJECT: 'REJECT'
};

/**
 * Reason codes for decisions
 */
const ReasonCode = {
    HIGH_CONFIDENCE: 'HIGH_CONFIDENCE',
    BELOW_THRESHOLD: 'BELOW_THRESHOLD',
    NO_MATCH: 'NO_MATCH',
    NO_CLASSIFICATION: 'NO_CLASSIFICATION',
    LOW_CLASSIFICATION: 'LOW_CLASSIFICATION',
    FORCE_OVERRIDE: 'FORCE_OVERRIDE'
};

/**
 * Load auto-send configuration
 * @param {string} customPath - Optional custom config path
 * @returns {object} Configuration object
 */
function loadConfig(customPath = null) {
    if (config && !customPath) {
        return config;
    }

    const configDir = path.dirname(customPath || path.join(__dirname, '..', 'config', 'auto-send.json'));
    const configFile = customPath || path.join(configDir, 'auto-send.json');

    try {
        if (fs.existsSync(configFile)) {
            const rawConfig = fs.readFileSync(configFile, 'utf-8');
            config = JSON.parse(rawConfig);
            configPath = configFile;
            console.log(`[AutoSend] Configuration loaded from ${configFile}`);
            return config;
        } else {
            // Use defaults if no config file
            config = getDefaultConfig();
            configPath = configFile;
            console.log('[AutoSend] No config file found, using defaults');
            return config;
        }
    } catch (error) {
        console.error(`[AutoSend] Error loading config: ${error.message}`);
        config = getDefaultConfig();
        return config;
    }
}

/**
 * Get default configuration
 * @returns {object} Default config object
 */
function getDefaultConfig() {
    return {
        enabled: true,
        defaultThreshold: 0.95,
        supplierRules: {
            CEMEX: { threshold: 0.90 },
            TARMAC: { threshold: 0.92 },
            CPI_EUROMIX: { threshold: 0.95 },
            ECOCEM: { threshold: 0.90 },
            HEIDELBERG: { threshold: 0.92 },
            SMARTFLOW: { threshold: 0.95 },
            "*": { threshold: 0.95 }
        },
        reviewRequired: {
            belowThreshold: true,
            lowConfidence: true,
            noMatch: true
        },
        autoRoute: {
            enabled: true,
            defaultRecipientRule: "SUPPLIER_MATCH"
        },
        confidenceWeights: {
            classification: 0.25,
            extraction: 0.35,
            matching: 0.40
        }
    };
}

/**
 * Get threshold for a specific supplier
 * @param {string} supplier - Supplier name (case-insensitive)
 * @returns {number} Confidence threshold
 */
function getSupplierThreshold(supplier) {
    const cfg = loadConfig();
    if (!supplier) {
        return cfg.defaultThreshold;
    }

    const normalizedSupplier = supplier.toUpperCase();

    // Check for exact match
    if (cfg.supplierRules[normalizedSupplier]) {
        return cfg.supplierRules[normalizedSupplier].threshold;
    }

    // Check for wildcard match
    if (cfg.supplierRules['*']) {
        return cfg.supplierRules['*'].threshold;
    }

    return cfg.defaultThreshold;
}

/**
 * Calculate overall confidence from pipeline scores
 * @param {object} scores - Individual confidence scores
 * @returns {number} Overall confidence (0-1)
 */
function calculateOverallConfidence(scores) {
    const cfg = loadConfig();
    const weights = cfg.confidenceWeights;

    const classificationScore = scores.classification || scores.classificationConfidence || 0;
    const extractionScore = scores.extraction || scores.extractionConfidence || 0;
    const matchingScore = scores.matching || scores.matchConfidence || 0;

    const overall = (
        (classificationScore * weights.classification) +
        (extractionScore * weights.extraction) +
        (matchingScore * weights.matching)
    );

    return Math.min(Math.max(overall, 0), 1); // Clamp between 0 and 1
}

/**
 * Evaluate auto-send decision for an attachment
 * @param {object} attachment - Attachment data with confidence scores
 * @param {object} matchResult - Job match result
 * @returns {object} Decision object with type, reason, and next action
 */
function shouldAutoSend(attachment = {}, matchResult = {}) {
    const cfg = loadConfig();

    // Check if auto-send is enabled
    if (!cfg.enabled) {
        return createDecision(
            DecisionType.MANUAL_REVIEW,
            ReasonCode.BELOW_THRESHOLD,
            'Auto-send is disabled in configuration'
        );
    }

    // Extract scores from attachment or match result
    const scores = {
        classification: attachment.classificationConfidence || attachment.metadata?.classificationConfidence || 0,
        extraction: attachment.extractionConfidence || 0,
        matching: matchResult.confidence || attachment.matchConfidence || 0
    };

    // Calculate overall confidence
    const overallConfidence = calculateOverallConfidence(scores);

    // Get supplier-specific threshold
    const supplier = attachment.supplier || matchResult.supplier || null;
    const threshold = getSupplierThreshold(supplier);

    // Decision logic
    if (!matchResult.found && cfg.reviewRequired.noMatch) {
        return createDecision(
            DecisionType.MANUAL_REVIEW,
            ReasonCode.NO_MATCH,
            `No job match found - requires manual review (threshold: ${threshold})`
        );
    }

    if (scores.classification < 0.5 && cfg.reviewRequired.lowClassification) {
        return createDecision(
            DecisionType.MANUAL_REVIEW,
            ReasonCode.LOW_CLASSIFICATION,
            `Classification confidence too low (${scores.classification.toFixed(2)}) - requires manual review`
        );
    }

    if (overallConfidence >= threshold) {
        return createDecision(
            DecisionType.AUTO_SEND,
            ReasonCode.HIGH_CONFIDENCE,
            `Overall confidence ${overallConfidence.toFixed(3)} meets threshold ${threshold} for ${supplier || 'default'}`
        );
    }

    // Below threshold - require manual review
    return createDecision(
        DecisionType.MANUAL_REVIEW,
        ReasonCode.BELOW_THRESHOLD,
        `Overall confidence ${overallConfidence.toFixed(3)} below threshold ${threshold} for ${supplier || 'default'}`
    );
}

/**
 * Create a decision object
 * @param {string} decisionType - Type of decision
 * @param {string} reasonCode - Reason code
 * @param {string} reason - Human-readable reason
 * @returns {object} Decision object
 */
function createDecision(decisionType, reasonCode, reason) {
    return {
        decision: decisionType,
        reasonCode,
        reason,
        nextAction: getNextAction(decisionType),
        timestamp: new Date().toISOString()
    };
}

/**
 * Map decision type to attachment status
 * @param {string} decisionType - The decision type
 * @returns {string} Next action/status
 */
function getNextAction(decisionType) {
    switch (decisionType) {
        case DecisionType.AUTO_SEND:
        case DecisionType.FORCE_SEND:
            return 'READY_FOR_EXPORT';
        case DecisionType.MANUAL_REVIEW:
            return 'REVIEW';
        case DecisionType.REJECT:
            return 'REJECTED';
        default:
            return 'REVIEW';
    }
}

/**
 * Evaluate with force-send override
 * @param {object} attachment - Attachment data
 * @param {object} matchResult - Job match result
 * @param {string} overrideReason - Reason for override
 * @returns {object} Force send decision
 */
function shouldForceSend(attachment, matchResult, overrideReason) {
    return createDecision(
        DecisionType.FORCE_SEND,
        ReasonCode.FORCE_OVERRIDE,
        `Force send override: ${overrideReason}`
    );
}

/**
 * Evaluate for rejection
 * @param {string} reason - Rejection reason
 * @returns {object} Rejection decision
 */
function shouldReject(reason) {
    return createDecision(
        DecisionType.REJECT,
        'REJECT',
        reason || 'Manual rejection'
    );
}

/**
 * Get configuration summary for API
 * @returns {object} Config summary
 */
function getConfigSummary() {
    const cfg = loadConfig();
    const thresholds = {};

    for (const [supplier, rule] of Object.entries(cfg.supplierRules)) {
        thresholds[supplier] = {
            threshold: rule.threshold,
            isDefault: supplier === '*'
        };
    }

    return {
        enabled: cfg.enabled,
        defaultThreshold: cfg.defaultThreshold,
        supplierThresholds: thresholds,
        confidenceWeights: cfg.confidenceWeights,
        reviewRequired: cfg.reviewRequired
    };
}

/**
 * Reload configuration from disk
 * @returns {object} Fresh configuration
 */
function reloadConfig() {
    config = null;
    return loadConfig();
}

/**
 * Validate configuration file
 * @param {string} configPath - Path to config file
 * @returns {object} Validation result
 */
function validateConfig(configPath) {
    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(content);

        const errors = [];

        if (typeof parsed.enabled !== 'boolean') {
            errors.push('enabled must be a boolean');
        }

        if (typeof parsed.defaultThreshold !== 'number' || parsed.defaultThreshold < 0 || parsed.defaultThreshold > 1) {
            errors.push('defaultThreshold must be a number between 0 and 1');
        }

        if (parsed.supplierRules) {
            for (const [supplier, rule] of Object.entries(parsed.supplierRules)) {
                if (typeof rule.threshold !== 'number' || rule.threshold < 0 || rule.threshold > 1) {
                    errors.push(`supplierRules.${supplier}.threshold must be a number between 0 and 1`);
                }
            }
        }

        if (parsed.confidenceWeights) {
            const weightTotal = (
                (parsed.confidenceWeights.classification || 0) +
                (parsed.confidenceWeights.extraction || 0) +
                (parsed.confidenceWeights.matching || 0)
            );
            if (Math.abs(weightTotal - 1.0) > 0.001) {
                errors.push(`confidenceWeights must sum to 1.0 (current: ${weightTotal.toFixed(3)})`);
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    } catch (error) {
        return {
            valid: false,
            errors: [`Failed to parse config: ${error.message}`]
        };
    }
}

module.exports = {
    DecisionType,
    ReasonCode,
    loadConfig,
    getSupplierThreshold,
    calculateOverallConfidence,
    shouldAutoSend,
    shouldForceSend,
    shouldReject,
    getNextAction,
    getConfigSummary,
    reloadConfig,
    validateConfig,
    getDefaultConfig
};
