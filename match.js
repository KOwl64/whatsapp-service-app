/**
 * Job Matching Module
 * Matches POD attachments against jobs/reference data using extracted fields
 * Provides fuzzy matching with configurable confidence thresholds
 */

const fs = require('fs');
const path = require('path');
const { fuzzyMatch, matchVehicleReg, parseVehicleReg, normalizeKey, jaroWinklerSimilarity } = require('./lib/matching');

// Configuration
let config = {
    // HRMS API endpoint for fetching jobs
    hrmsApiEndpoint: process.env.HRMS_API_ENDPOINT || 'http://localhost:8000',
    // API token for authentication
    apiToken: process.env.HRMS_API_TOKEN || '',
    // Enable/disable HRMS API calls
    useApi: false,
    // Confidence thresholds
    thresholds: {
        exactJobRef: 1.0,
        exactVehicleReg: 0.95,
        fuzzyJobRef: 0.90,
        fuzzyVehicleReg: 0.85,
        minMatch: 0.70  // Below this, flag for manual review
    },
    // Local jobs cache (for testing without API)
    localJobs: []
};

/**
 * Initialize the matching module
 * @param {Object} options - Configuration options
 */
function init(options = {}) {
    config = { ...config, ...options };

    // Try to load local jobs from file if available
    const localJobsPath = process.env.LOCAL_JOBS_PATH || path.join(__dirname, 'data', 'jobs.json');
    if (fs.existsSync(localJobsPath)) {
        try {
            const jobsData = JSON.parse(fs.readFileSync(localJobsPath, 'utf8'));
            config.localJobs = Array.isArray(jobsData) ? jobsData : [];
            console.log(`[Match] Loaded ${config.localJobs.length} local jobs from ${localJobsPath}`);
        } catch (err) {
            console.warn(`[Match] Failed to load local jobs: ${err.message}`);
        }
    }

    console.log('[Match] Initialized with config:', {
        useApi: config.useApi,
        thresholds: config.thresholds,
        localJobsCount: config.localJobs.length
    });
}

/**
 * Fetch jobs from HRMS API
 * @param {Object} filters - Optional filters (jobRef, vehicleReg, date)
 * @returns {Promise<Array>} Array of job objects
 */
async function fetchJobsFromApi(filters = {}) {
    if (!config.useApi) {
        return config.localJobs;
    }

    try {
        const url = new URL('/api/jobs', config.hrmsApiEndpoint);

        if (filters.jobRef) url.searchParams.append('job_ref', filters.jobRef);
        if (filters.vehicleReg) url.searchParams.append('vehicle_reg', filters.vehicleReg);
        if (filters.date) url.searchParams.append('date', filters.date);

        const response = await fetch(url.toString(), {
            headers: {
                'Authorization': `Bearer ${config.apiToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        return await response.json();
    } catch (err) {
        console.error(`[Match] Failed to fetch jobs from API: ${err.message}`);
        return config.localJobs;
    }
}

/**
 * Match a single job reference
 * @param {string} jobRef - Job reference to match
 * @param {Array} jobs - Array of jobs to search
 * @returns {Object} Match result with score
 */
function matchJobRef(jobRef, jobs) {
    if (!jobRef || !jobs || jobs.length === 0) {
        return { jobId: null, jobRef: null, score: 0, matchType: 'NO_MATCH' };
    }

    // First, try exact match
    for (const job of jobs) {
        const jobRefValue = job.job_ref || job.ref || job.jobReference || '';
        if (normalizeKey(jobRefValue) === normalizeKey(jobRef)) {
            return {
                jobId: job.id,
                jobRef: jobRefValue,
                score: config.thresholds.exactJobRef,
                matchType: 'EXACT_JOB_REF'
            };
        }
    }

    // Try fuzzy match
    let bestMatch = null;
    let bestScore = 0;

    for (const job of jobs) {
        const jobRefValue = job.job_ref || job.ref || job.jobReference || '';
        const score = fuzzyMatch(jobRef, jobRefValue, config.thresholds.fuzzyJobRef);

        if (score > bestScore) {
            bestScore = score;
            bestMatch = {
                jobId: job.id,
                jobRef: jobRefValue,
                score,
                matchType: score >= config.thresholds.fuzzyJobRef ? 'FUZZY_JOB_REF' : 'NO_MATCH'
            };
        }
    }

    return bestScore >= config.thresholds.fuzzyJobRef ? bestMatch : { jobId: null, jobRef: null, score: 0, matchType: 'NO_MATCH' };
}

/**
 * Match a single vehicle registration
 * @param {string} vehicleReg - Vehicle registration to match
 * @param {Array} jobs - Array of jobs to search
 * @returns {Object} Match result with score
 */
function matchVehicleRegistration(vehicleReg, jobs) {
    if (!vehicleReg || !jobs || jobs.length === 0) {
        return { jobId: null, jobRef: null, score: 0, matchType: 'NO_MATCH' };
    }

    // First, try exact match
    for (const job of jobs) {
        const jobVehicleReg = job.vehicle_reg || job.vehicleReg || job.vehicleRegistration || '';
        if (matchVehicleReg(vehicleReg, jobVehicleReg)) {
            return {
                jobId: job.id,
                jobRef: job.job_ref || job.ref || '',
                score: config.thresholds.exactVehicleReg,
                matchType: 'EXACT_VEHICLE_REG'
            };
        }
    }

    // Try fuzzy match
    let bestMatch = null;
    let bestScore = 0;

    for (const job of jobs) {
        const jobVehicleReg = job.vehicle_reg || job.vehicleReg || job.vehicleRegistration || '';
        const score = jaroWinklerSimilarity(
            normalizeKey(vehicleReg),
            normalizeKey(jobVehicleReg)
        );

        if (score > bestScore) {
            bestScore = score;
            bestMatch = {
                jobId: job.id,
                jobRef: job.job_ref || job.ref || '',
                score,
                matchType: score >= config.thresholds.fuzzyVehicleReg ? 'FUZZY_VEHICLE_REG' : 'NO_MATCH'
            };
        }
    }

    return bestScore >= config.thresholds.fuzzyVehicleReg ? bestMatch : { jobId: null, jobRef: null, score: 0, matchType: 'NO_MATCH' };
}

/**
 * Find best match for extracted POD fields against jobs data
 * @param {Object} extractedFields - Fields extracted from POD
 * @param {string} attachmentId - Attachment ID for logging
 * @returns {Promise<Object>} Match result with confidence and candidates
 */
async function findMatch(extractedFields, attachmentId = null) {
    const startTime = Date.now();

    // Extract fields (handle both formats from extractor.js)
    const jobRef = extractedFields?.jobRef || extractedFields?.job_ref || null;
    const vehicleReg = extractedFields?.vehicleReg || extractedFields?.vehicle_reg || null;
    const date = extractedFields?.date || null;
    const supplier = extractedFields?.supplier || null;

    // Fetch potential jobs from API
    const jobs = await fetchJobsFromApi({ jobRef, vehicleReg, date });

    if (jobs.length === 0) {
        const result = {
            match: null,
            candidates: [],
            summary: {
                status: 'NO_JOBS_FOUND',
                duration: Date.now() - startTime,
                extractedFields: { jobRef, vehicleReg, date, supplier }
            }
        };

        logMatchAttempt(attachmentId, result, extractedFields);
        return result;
    }

    // Perform matching in priority order:
    // 1. Exact jobRef match
    // 2. Exact vehicleReg match
    // 3. Fuzzy jobRef match
    // 4. Fuzzy vehicleReg match

    const candidates = [];

    // Try exact jobRef match
    const exactJobRefMatch = matchJobRef(jobRef, jobs);
    if (exactJobRefMatch.score > 0) {
        candidates.push(exactJobRefMatch);
    }

    // Try exact vehicleReg match
    const exactVehicleMatch = matchVehicleRegistration(vehicleReg, jobs);
    if (exactVehicleMatch.score > 0) {
        candidates.push(exactVehicleMatch);
    }

    // If no exact matches, try fuzzy matching
    if (candidates.length === 0) {
        const fuzzyJobRefMatch = matchJobRef(jobRef, jobs);
        if (fuzzyJobRefMatch.score > 0) {
            candidates.push(fuzzyJobRefMatch);
        }

        const fuzzyVehicleMatch = matchVehicleRegistration(vehicleReg, jobs);
        if (fuzzyVehicleMatch.score > 0) {
            candidates.push(fuzzyVehicleMatch);
        }
    }

    // Sort candidates by score (highest first)
    candidates.sort((a, b) => b.score - a.score);

    // Determine best match
    const bestCandidate = candidates.length > 0 ? candidates[0] : null;

    const result = {
        match: bestCandidate ? {
            jobId: bestCandidate.jobId,
            jobRef: bestCandidate.jobRef,
            confidence: bestCandidate.score,
            matchType: bestCandidate.matchType
        } : null,
        candidates: candidates.map(c => ({
            jobId: c.jobId,
            jobRef: c.jobRef,
            confidence: c.score,
            matchType: c.matchType
        })),
        summary: {
            status: bestCandidate ? 'MATCHED' : 'NO_MATCH',
            duration: Date.now() - startTime,
            bestScore: bestCandidate?.score || 0,
            extractedFields: { jobRef, vehicleReg, date, supplier },
            jobsSearched: jobs.length
        }
    };

    logMatchAttempt(attachmentId, result, extractedFields);
    return result;
}

/**
 * Find match by job reference only
 * @param {string} jobRef - Job reference to find
 * @returns {Promise<Object>} Match result
 */
async function findByJobRef(jobRef) {
    const jobs = await fetchJobsFromApi({ jobRef });
    const match = matchJobRef(jobRef, jobs);

    return {
        job: match.score > 0 ? {
            id: match.jobId,
            ref: match.jobRef
        } : null,
        confidence: match.score,
        matchType: match.matchType
    };
}

/**
 * Find match by vehicle registration only
 * @param {string} vehicleReg - Vehicle registration to find
 * @returns {Promise<Object>} Match result
 */
async function findByVehicleReg(vehicleReg) {
    const jobs = await fetchJobsFromApi({ vehicleReg });
    const match = matchVehicleRegistration(vehicleReg, jobs);

    return {
        job: match.score > 0 ? {
            id: match.jobId,
            ref: match.jobRef
        } : null,
        confidence: match.score,
        matchType: match.matchType
    };
}

/**
 * Find best match using sender information as fallback
 * @param {Object} options - Options including sender phone
 * @returns {Promise<Object>} Match result
 */
async function findBestMatch(options = {}) {
    const { sender, jobRef, vehicleReg, date } = options;

    // Prefer explicit fields if provided
    if (jobRef) return findByJobRef(jobRef);
    if (vehicleReg) return findByVehicleReg(vehicleReg);

    // Fallback: try to find job by sender (phone number)
    if (sender && config.useApi) {
        try {
            const url = new URL('/api/jobs/by-sender', config.hrmsApiEndpoint);
            url.searchParams.append('phone', sender);

            const response = await fetch(url.toString(), {
                headers: {
                    'Authorization': `Bearer ${config.apiToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const jobs = await response.json();
                if (jobs.length > 0) {
                    return {
                        job: {
                            id: jobs[0].id,
                            ref: jobs[0].job_ref || jobs[0].ref
                        },
                        confidence: 0.5,  // Lower confidence for sender-based match
                        matchType: 'SENDER_MATCH'
                    };
                }
            }
        } catch (err) {
            console.warn(`[Match] Sender match failed: ${err.message}`);
        }
    }

    return { job: null, confidence: 0, matchType: 'NO_MATCH' };
}

/**
 * Log match attempt for audit trail
 * @param {string} attachmentId - Attachment ID
 * @param {Object} result - Match result
 * @param {Object} extractedFields - Extracted fields used for matching
 */
function logMatchAttempt(attachmentId, result, extractedFields) {
    const logData = {
        attachmentId,
        timestamp: new Date().toISOString(),
        extractedFields: {
            jobRef: extractedFields?.jobRef,
            vehicleReg: extractedFields?.vehicleReg,
            date: extractedFields?.date,
            supplier: extractedFields?.supplier
        },
        matchResult: result
    };

    // Log to console for debugging
    console.log('[Match] Attempt:', JSON.stringify(logData, null, 2));

    // In production, this would write to audit logs
    // The service.js already handles audit.logMatch() calls
}

/**
 * Get match status description based on confidence score
 * @param {number} confidence - Confidence score 0-1
 * @returns {string} Status description
 */
function getMatchStatus(confidence) {
    if (confidence >= 0.95) return 'HIGH_CONFIDENCE';
    if (confidence >= config.thresholds.minMatch) return 'MEDIUM_CONFIDENCE';
    return 'LOW_CONFIDENCE';
}

/**
 * Determine if match should be auto-approved or require review
 * @param {number} confidence - Match confidence score
 * @returns {string} 'AUTO_APPROVE' or 'REVIEW_REQUIRED'
 */
function getReviewStatus(confidence) {
    if (confidence >= 0.95) return 'AUTO_APPROVE';
    if (confidence >= config.thresholds.minMatch) return 'REVIEW_REQUIRED';
    return 'REVIEW_REQUIRED';
}

module.exports = {
    init,
    findMatch,
    findByJobRef,
    findByVehicleReg,
    findBestMatch,
    getMatchStatus,
    getReviewStatus,
    // Exported for testing
    matchJobRef,
    matchVehicleRegistration,
    config
};
