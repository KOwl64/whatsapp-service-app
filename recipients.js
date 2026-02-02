/**
 * Customer Recipient Rules Module
 * Manages customer-specific email recipient rules for POD distribution
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Default rules directory
const RULES_DIR = process.env.CUSTOMER_RULES_DIR || '/data/customers';
const RULES_FILE = path.join(RULES_DIR, 'rules.json');
const DEFAULT_RECIPIENTS_FILE = path.join(RULES_DIR, 'default.json');

// In-memory cache
let rulesCache = null;
let defaultRecipientsCache = null;
let lastLoadTime = null;

// Rule types
const RULE_TYPES = {
    BY_JOB_REF: 'BY_JOB_REF',
    BY_CUSTOMER: 'BY_CUSTOMER',
    BY_VEHICLE: 'BY_VEHICLE',
    DEFAULT: 'DEFAULT'
};

/**
 * Ensure rules directory exists
 */
function ensureRulesDir() {
    if (!fs.existsSync(RULES_DIR)) {
        fs.mkdirSync(RULES_DIR, { recursive: true });
    }
}

/**
 * Load rules from file or create default
 */
function loadRules() {
    const now = Date.now();

    // Cache for 30 seconds
    if (rulesCache && lastLoadTime && (now - lastLoadTime) < 30000) {
        return rulesCache;
    }

    ensureRulesDir();

    try {
        if (fs.existsSync(RULES_FILE)) {
            const content = fs.readFileSync(RULES_FILE, 'utf8');
            rulesCache = JSON.parse(content);
        } else {
            // Create default rules structure
            rulesCache = {
                version: '1.0',
                customers: {},
                wildcardRules: []
            };
            saveRules();
        }
    } catch (error) {
        console.error('[Recipients] Error loading rules:', error.message);
        rulesCache = { version: '1.0', customers: {}, wildcardRules: [] };
    }

    lastLoadTime = now;
    return rulesCache;
}

/**
 * Save rules to file
 */
function saveRules() {
    ensureRulesDir();

    try {
        fs.writeFileSync(RULES_FILE, JSON.stringify(rulesCache, null, 2));
    } catch (error) {
        console.error('[Recipients] Error saving rules:', error.message);
    }
}

/**
 * Load default recipients
 */
function loadDefaultRecipients() {
    if (defaultRecipientsCache) return defaultRecipientsCache;

    ensureRulesDir();

    try {
        if (fs.existsSync(DEFAULT_RECIPIENTS_FILE)) {
            const content = fs.readFileSync(DEFAULT_RECIPIENTS_FILE, 'utf8');
            defaultRecipientsCache = JSON.parse(content);
        } else {
            // Default internal recipients
            defaultRecipientsCache = {
                internal: ['operations@turners-distribution.cloud'],
                external: [],
                autoSend: false
            };
            saveDefaultRecipients();
        }
    } catch (error) {
        console.error('[Recipients] Error loading default recipients:', error.message);
        defaultRecipientsCache = {
            internal: ['operations@turners-distribution.cloud'],
            external: [],
            autoSend: false
        };
    }

    return defaultRecipientsCache;
}

/**
 * Save default recipients
 */
function saveDefaultRecipients() {
    try {
        fs.writeFileSync(DEFAULT_RECIPIENTS_FILE, JSON.stringify(defaultRecipientsCache, null, 2));
    } catch (error) {
        console.error('[Recipients] Error saving default recipients:', error.message);
    }
}

/**
 * Initialize the recipients module
 */
async function init() {
    console.log('[Recipients] Initializing recipient rules...');
    loadRules();
    loadDefaultRecipients();
    console.log(`[Recipients] Loaded ${Object.keys(rulesCache.customers).length} customer rules`);
}

/**
 * Match a pattern against a value
 * Supports wildcards: * (any characters), ? (single character)
 */
function matchPattern(pattern, value) {
    if (!pattern || !value) return false;

    // Convert glob pattern to regex
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
        .replace(/\*/g, '.*') // * matches any characters
        .replace(/\?/g, '.'); // ? matches single character

    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(value);
}

/**
 * Get recipients for a customer/job
 * @param {string} customerName - Customer name or identifier
 * @param {string} jobRef - Job reference (optional)
 * @param {string} vehicleReg - Vehicle registration (optional)
 * @param {string} senderPhone - Sender phone number (optional)
 * @returns {Object} Recipients with to, cc, internal flags
 */
function getRecipients(customerName, jobRef, vehicleReg, senderPhone) {
    const rules = loadRules();
    const defaults = loadDefaultRecipients();

    // 1. Check customer-specific rules (highest priority)
    if (customerName && rules.customers[customerName]) {
        const customerRule = rules.customers[customerName];
        return {
            to: customerRule.recipients || [],
            cc: customerRule.cc || [],
            bcc: customerRule.bcc || [],
            internal: false,
            source: 'customer',
            customer: customerName
        };
    }

    // 2. Check wildcard rules (by job ref, vehicle, etc.)
    for (const rule of rules.wildcardRules || []) {
        let matched = false;

        switch (rule.type) {
            case RULE_TYPES.BY_JOB_REF:
                if (jobRef && matchPattern(rule.match, jobRef)) matched = true;
                break;
            case RULE_TYPES.BY_VEHICLE:
                if (vehicleReg && matchPattern(rule.match, vehicleReg)) matched = true;
                break;
            case RULE_TYPES.BY_CUSTOMER:
                if (customerName && matchPattern(rule.match, customerName)) matched = true;
                break;
        }

        if (matched) {
            return {
                to: rule.recipients || [],
                cc: rule.cc || [],
                bcc: rule.bcc || [],
                internal: false,
                source: 'wildcard',
                matchedRule: rule
            };
        }
    }

    // 3. Return default recipients
    return {
        to: defaults.external || [],
        cc: defaults.internal || [],
        bcc: [],
        internal: true,
        source: 'default',
        autoSend: defaults.autoSend
    };
}

/**
 * Get internal recipients only (for CC)
 */
function getInternalRecipients() {
    const defaults = loadDefaultRecipients();
    return defaults.internal || [];
}

/**
 * Check if a customer has auto-send enabled
 */
function isAutoSendEnabled(customerName) {
    const rules = loadRules();

    if (customerName && rules.customers[customerName]) {
        return rules.customers[customerName].autoSend !== false;
    }

    const defaults = loadDefaultRecipients();
    return defaults.autoSend === true;
}

/**
 * Add or update a customer rule
 */
function setCustomerRule(customerName, config) {
    const rules = loadRules();

    rules.customers[customerName] = {
        recipients: config.recipients || [],
        cc: config.cc || [],
        bcc: config.bcc || [],
        autoSend: config.autoSend !== false,
        template: config.template || 'default',
        updatedAt: new Date().toISOString()
    };

    saveRules();
    rulesCache = null; // Invalidate cache

    console.log(`[Recipients] Updated rule for customer: ${customerName}`);
    return rules.customers[customerName];
}

/**
 * Add or update a wildcard rule
 */
function setWildcardRule(type, pattern, config) {
    const rules = loadRules();

    // Remove existing rule with same type and pattern
    rules.wildcardRules = (rules.wildcardRules || []).filter(
        r => !(r.type === type && r.match === pattern)
    );

    // Add new rule
    rules.wildcardRules.push({
        type,
        match: pattern,
        recipients: config.recipients || [],
        cc: config.cc || [],
        bcc: config.bcc || [],
        updatedAt: new Date().toISOString()
    });

    saveRules();
    rulesCache = null; // Invalidate cache

    console.log(`[Recipients] Updated wildcard rule: ${type}=${pattern}`);
    return rules.wildcardRules[rules.wildcardRules.length - 1];
}

/**
 * Delete a customer rule
 */
function deleteCustomerRule(customerName) {
    const rules = loadRules();

    if (rules.customers[customerName]) {
        delete rules.customers[customerName];
        saveRules();
        rulesCache = null;
        console.log(`[Recipients] Deleted rule for customer: ${customerName}`);
        return true;
    }

    return false;
}

/**
 * Delete a wildcard rule
 */
function deleteWildcardRule(type, pattern) {
    const rules = loadRules();
    const before = rules.wildcardRules?.length || 0;

    rules.wildcardRules = (rules.wildcardRules || []).filter(
        r => !(r.type === type && r.match === pattern)
    );

    if ((rules.wildcardRules?.length || 0) < before) {
        saveRules();
        rulesCache = null;
        console.log(`[Recipients] Deleted wildcard rule: ${type}=${pattern}`);
        return true;
    }

    return false;
}

/**
 * Get all customer rules
 */
function getAllCustomerRules() {
    const rules = loadRules();
    return Object.entries(rules.customers).map(([name, config]) => ({
        customer: name,
        ...config
    }));
}

/**
 * Get all wildcard rules
 */
function getAllWildcardRules() {
    const rules = loadRules();
    return rules.wildcardRules || [];
}

/**
 * Get default recipients config
 */
function getDefaultConfig() {
    return loadDefaultRecipients();
}

/**
 * Set default recipients config
 */
function setDefaultConfig(config) {
    defaultRecipientsCache = {
        internal: config.internal || ['operations@turners-distribution.cloud'],
        external: config.external || [],
        autoSend: config.autoSend === true
    };
    saveDefaultRecipients();
    defaultRecipientsCache = null; // Invalidate cache
}

/**
 * Get module status
 */
function getStatus() {
    const rules = loadRules();
    const defaults = loadDefaultRecipients();

    return {
        loaded: true,
        customerCount: Object.keys(rules.customers).length,
        wildcardRuleCount: rules.wildcardRules?.length || 0,
        rulesFile: RULES_FILE,
        defaultsFile: DEFAULT_RECIPIENTS_FILE,
        internalRecipients: defaults.internal?.length || 0,
        externalRecipients: defaults.external?.length || 0,
        autoSendEnabled: defaults.autoSend
    };
}

/**
 * Export rules to file
 */
function exportRules(format = 'json') {
    const rules = loadRules();
    const defaults = loadDefaultRecipients();

    if (format === 'json') {
        return JSON.stringify({ rules, defaults }, null, 2);
    }

    // Export as CSV-friendly format
    const lines = ['Customer,Recipients,CC,BCC,AutoSend,Template'];

    for (const [name, config] of Object.entries(rules.customers)) {
        lines.push(`${name},"${(config.recipients || []).join('; ')}","${(config.cc || []).join('; ')}","${(config.bcc || []).join('; ')}",${config.autoSend},${config.template || 'default'}`);
    }

    return lines.join('\n');
}

/**
 * Import rules from file
 */
function importRules(content) {
    try {
        const data = JSON.parse(content);

        if (data.rules) {
            rulesCache = data.rules;
            saveRules();
        }

        if (data.defaults) {
            defaultRecipientsCache = data.defaults;
            saveDefaultRecipients();
        }

        rulesCache = null;
        defaultRecipientsCache = null;

        console.log('[Recipients] Rules imported successfully');
        return true;
    } catch (error) {
        console.error('[Recipients] Error importing rules:', error.message);
        return false;
    }
}

module.exports = {
    RULE_TYPES,
    init,
    getRecipients,
    getInternalRecipients,
    isAutoSendEnabled,
    setCustomerRule,
    setWildcardRule,
    deleteCustomerRule,
    deleteWildcardRule,
    getAllCustomerRules,
    getAllWildcardRules,
    getDefaultConfig,
    setDefaultConfig,
    getStatus,
    exportRules,
    importRules
};
