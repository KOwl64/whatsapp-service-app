// lib/auth-middleware.js
// Basic authentication middleware for dashboard protection

const auth = require('basic-auth');
const crypto = require('crypto');

// Load credentials from environment or config
const getCredentials = () => {
  return {
    user: process.env.DASHBOARD_USER || 'admin',
    pass: process.env.DASHBOARD_PASS || process.env.DASHBOARD_PASSWORD || 'ChangeMe123!'
  };
};

// Store for tracking failed attempts
const failedAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

/**
 * Check if IP is locked out
 */
function isLockedOut(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return false;

  if (Date.now() - record.lockoutStart > LOCKOUT_DURATION) {
    failedAttempts.delete(ip);
    return false;
  }
  return record.attempts >= MAX_ATTEMPTS;
}

/**
 * Record failed attempt
 */
function recordFailedAttempt(ip) {
  const record = failedAttempts.get(ip) || { attempts: 0, lockoutStart: null };
  record.attempts += 1;

  if (record.attempts >= MAX_ATTEMPTS && !record.lockoutStart) {
    record.lockoutStart = Date.now();
  }

  failedAttempts.set(ip, record);
}

/**
 * Clear failed attempts on successful login
 */
function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

/**
 * Authentication middleware
 */
function requireAuth(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress;

  // Check for lockout
  if (isLockedOut(clientIp)) {
    return res.status(403).json({
      success: false,
      error: 'Too many failed attempts. Please try again in 15 minutes.'
    });
  }

  // Get credentials from Authorization header
  const credentials = auth(req);

  if (!credentials) {
    // Return 401 with WWW-Authenticate header
    res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please provide credentials.'
    });
  }

  const { user, pass } = getCredentials();

  // Verify credentials
  if (credentials.name === user && credentials.pass === pass) {
    clearFailedAttempts(clientIp);
    req.authenticatedUser = credentials.name;
    return next();
  }

  // Failed authentication
  recordFailedAttempt(clientIp);
  console.warn(`[AUTH] Failed auth attempt from ${clientIp} for user: ${credentials.name}`);

  res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
  return res.status(401).json({
    success: false,
    error: 'Invalid credentials.'
  });
}

/**
 * Optional: Check auth but allow public access
 */
function optionalAuth(req, res, next) {
  const credentials = auth(req);

  if (credentials) {
    const { user, pass } = getCredentials();
    if (credentials.name === user && credentials.pass === pass) {
      req.authenticatedUser = credentials.name;
    }
  }

  next();
}

module.exports = {
  requireAuth,
  optionalAuth,
  getCredentials
};
