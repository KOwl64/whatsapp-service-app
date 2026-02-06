/**
 * Fuzzy String Matching Utilities
 * Provides normalized comparison and fuzzy matching for job reference and vehicle registration matching
 */

/**
 * Normalize a string for comparison
 * Lowercase, remove spaces and special characters
 * @param {string} str - String to normalize
 * @returns {string} Normalized string
 */
function normalizeKey(str) {
    if (!str || typeof str !== 'string') return '';
    return str.toLowerCase().replace(/[\s\-_]+/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Edit distance
 */
function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;

    // Create distance matrix
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    // Initialize first row and column
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    // Fill matrix
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(
                    dp[i - 1][j],     // deletion
                    dp[i][j - 1],     // insertion
                    dp[i - 1][j - 1]  // substitution
                );
            }
        }
    }

    return dp[m][n];
}

/**
 * Calculate Jaro-Winkler similarity between two strings
 * Better for short strings like job references
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity score 0.0-1.0
 */
function jaroWinklerSimilarity(str1, str2) {
    if (str1 === str2) return 1.0;
    if (!str1 || !str2) return 0.0;

    const len1 = str1.length;
    const len2 = str2.length;

    if (len1 === 0 || len2 === 0) return 0.0;

    // Match window (half the distance between strings)
    const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
    if (matchWindow < 0) return 0.0;

    const s1Arr = str1.split('');
    const s2Arr = str2.split('');

    const s1Matches = Array(len1).fill(false);
    const s2Matches = Array(len2).fill(false);

    let matches = 0;
    let transpositions = 0;

    // Find matches
    for (let i = 0; i < len1; i++) {
        const start = Math.max(0, i - matchWindow);
        const end = Math.min(i + matchWindow + 1, len2);

        for (let j = start; j < end; j++) {
            if (s2Matches[j] || s1Arr[i] !== s2Arr[j]) continue;
            s1Matches[i] = true;
            s2Matches[j] = true;
            matches++;
            break;
        }
    }

    if (matches === 0) return 0.0;

    // Count transpositions
    let k = 0;
    for (let i = 0; i < len1; i++) {
        if (!s1Matches[i]) continue;
        while (!s2Matches[k]) k++;
        if (s1Arr[i] !== s2Arr[k]) transpositions++;
        k++;
    }
    transpositions = transpositions / 2;

    // Jaro similarity
    const jaro = (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3;

    // Winkler modification (boost for common prefix)
    const prefixLen = getCommonPrefixLength(str1, str2);
    const prefixBonus = prefixLen > 0 ? Math.min(prefixLen, 4) * 0.1 * (1 - jaro) : 0;

    return Math.min(jaro + prefixBonus, 1.0);
}

/**
 * Get length of common prefix between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Length of common prefix
 */
function getCommonPrefixLength(str1, str2) {
    const maxLen = Math.min(str1.length, str2.length);
    let len = 0;
    while (len < maxLen && str1[len] === str2[len]) {
        len++;
    }
    return len;
}

/**
 * Fuzzy match two strings with configurable threshold
 * Uses Jaro-Winkler for similarity (better for short codes)
 * @param {string} input - Input string
 * @param {string} target - Target string to match against
 * @param {number} threshold - Minimum similarity score (0.0-1.0), default 0.8
 * @returns {number} Similarity score 0.0-1.0 (or -1 if below threshold)
 */
function fuzzyMatch(input, target, threshold = 0.8) {
    if (!input || !target) return 0.0;
    if (input === target) return 1.0;

    // Normalize both strings
    const normInput = normalizeKey(input);
    const normTarget = normalizeKey(target);

    if (normInput === normTarget) return 1.0;

    // Use Jaro-Winkler for better short-string matching
    const similarity = jaroWinklerSimilarity(normInput, normTarget);

    return similarity >= threshold ? similarity : 0.0;
}

/**
 * Parse UK vehicle registration from string
 * Handles various formats with or without spaces
 * @param {string} str - String containing vehicle registration
 * @returns {string|null} Normalized vehicle registration or null
 */
function parseVehicleReg(str) {
    if (!str || typeof str !== 'string') return null;

    // Remove spaces and normalize
    const cleaned = str.toUpperCase().replace(/\s+/g, '').trim();

    // UK vehicle registration patterns
    // Current format: 2 letters + 2 numbers + 3 letters (e.g., GV66XRO)
    const currentPattern = /^[A-Z]{2}\d{2}[A-Z]{3}$/;
    // Prefix format: 1-3 letters + 1-4 numbers + up to 3 letters
    const prefixPattern = /^[A-Z]{1,3}\d{1,4}[A-Z]{0,3}$/;
    // Suffix format: 1-4 numbers + 1-3 letters
    const suffixPattern = /^\d{1,4}[A-Z]{1,3}$/;
    // Northern Ireland format: 1-2 letters + 1-4 numbers + 1-2 letters
    const niPattern = /^[A-Z]{1,2}\d{1,4}[A-Z]{1,2}$/;

    if (currentPattern.test(cleaned) ||
        prefixPattern.test(cleaned) ||
        suffixPattern.test(cleaned) ||
        niPattern.test(cleaned)) {
        return cleaned;
    }

    return null;
}

/**
 * Match two vehicle registrations (exact match with normalization)
 * @param {string} input - Input vehicle registration
 * @param {string} target - Target vehicle registration
 * @returns {boolean} True if they match
 */
function matchVehicleReg(input, target) {
    const parsedInput = parseVehicleReg(input);
    const parsedTarget = parseVehicleReg(target);

    if (!parsedInput || !parsedTarget) return false;

    return parsedInput === parsedTarget;
}

/**
 * Match vehicle registrations with fuzzy support
 * Uses exact match first, then fuzzy if enabled
 * @param {string} input - Input vehicle registration
 * @param {string} target - Target vehicle registration
 * @param {boolean} fuzzy - Whether to use fuzzy matching, default true
 * @returns {number} Match score 0.0-1.0
 */
function matchVehicleRegAdvanced(input, target, fuzzy = true) {
    const parsedInput = parseVehicleReg(input);
    const parsedTarget = parseVehicleReg(target);

    if (!parsedInput || !parsedTarget) return 0.0;

    // Exact match
    if (parsedInput === parsedTarget) return 1.0;

    // Fuzzy match for similar registrations (one character off)
    if (fuzzy) {
        const similarity = jaroWinklerSimilarity(parsedInput, parsedTarget);
        if (similarity >= 0.85) return similarity;
    }

    return 0.0;
}

/**
 * Batch match input against multiple targets
 * @param {string} input - Input string to match
 * @param {Array} targets - Array of target strings
 * @param {Object} options - Match options
 * @returns {Array} Sorted array of {target, score} matches
 */
function batchMatch(input, targets, options = {}) {
    const { threshold = 0.8, fuzzy = true, limit = 10 } = options;

    if (!input || !targets || !Array.isArray(targets)) {
        return [];
    }

    const matches = targets
        .map(target => ({
            target,
            score: fuzzyMatch(input, target, threshold)
        }))
        .filter(match => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return matches;
}

module.exports = {
    normalizeKey,
    levenshteinDistance,
    jaroWinklerSimilarity,
    fuzzyMatch,
    parseVehicleReg,
    matchVehicleReg,
    matchVehicleRegAdvanced,
    batchMatch,
    getCommonPrefixLength
};
