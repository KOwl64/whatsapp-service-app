// lib/ip-whitelist.js
// IP-based access control middleware

const allowedIPs = new Set();

/**
 * Load allowed IPs from environment or file
 */
function loadAllowedIPs() {
  // From environment variable (comma-separated)
  const envIPs = process.env.ALLOWED_IPS || '';
  if (envIPs) {
    envIPs.split(',').forEach(ip => {
      allowedIPs.add(ip.trim());
    });
  }

  // From file (one IP per line)
  const filePath = process.env.IP_WHITELIST_FILE || '/home/pgooch/whatsapp-service-app/ip-whitelist.txt';
  try {
    const fs = require('fs');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      content.split('\n').forEach(line => {
        const ip = line.trim().split('#')[0].trim(); // Remove comments
        if (ip) allowedIPs.add(ip);
      });
    }
  } catch (err) {
    console.warn('[IP WHITELIST] Could not load whitelist file:', err.message);
  }

  console.log(`[IP WHITELIST] Loaded ${allowedIPs.size} allowed IPs`);
}

/**
 * Check if IP is in whitelist
 */
function isIPAllowed(ip) {
  // Handle IPv6 mapped IPv4 addresses
  const normalizedIP = ip.replace(/^::ffff:/, '');

  // Check exact match
  if (allowedIPs.has(normalizedIP)) return true;

  // Check CIDR ranges
  for (const allowed of allowedIPs) {
    if (allowed.includes('/')) {
      if (cidrMatch(normalizedIP, allowed)) return true;
    }
  }

  return false;
}

/**
 * Check if IP matches CIDR pattern
 */
function cidrMatch(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const mask = ~(2 ** (32 - parseInt(bits)) - 1);

  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);

  return (ipNum & mask) === (rangeNum & mask);
}

function ipToNumber(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

/**
 * IP whitelist middleware
 */
function requireIPWhitelist(req, res, next) {
  const clientIP = req.ip || req.connection.remoteAddress.replace(/^::ffff:/, '');

  // Load on first request
  if (allowedIPs.size === 0) {
    loadAllowedIPs();
  }

  // Empty whitelist means all IPs allowed
  if (allowedIPs.size === 0) {
    return next();
  }

  if (!isIPAllowed(clientIP)) {
    console.warn(`[IP WHITELIST] Blocked access from ${clientIP}`);
    return res.status(403).json({
      success: false,
      error: 'Access denied. Your IP is not whitelisted.'
    });
  }

  next();
}

/**
 * Get current whitelist
 */
function getWhitelist() {
  return Array.from(allowedIPs);
}

/**
 * Add IP to whitelist (runtime)
 */
function addIP(ip) {
  allowedIPs.add(ip);
}

/**
 * Remove IP from whitelist (runtime)
 */
function removeIP(ip) {
  allowedIPs.delete(ip);
}

// Initialize
loadAllowedIPs();

module.exports = {
  requireIPWhitelist,
  getWhitelist,
  addIP,
  removeIP,
  loadAllowedIPs
};
