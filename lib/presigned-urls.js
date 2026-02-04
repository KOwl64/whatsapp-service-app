/**
 * Pre-signed URL Generation Service
 *
 * Generates pre-signed URLs for direct browser uploads/downloads to R2.
 * Uses @aws-sdk/s3-request-presigner for URL signing.
 */

const crypto = require('crypto');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { r2, R2_BUCKET, R2_PUBLIC_URL } = require('./r2');

// Configuration - URL expiration times in seconds
const UPLOAD_URL_EXPIRY = parseInt(process.env.R2_UPLOAD_URL_EXPIRY) || 900;   // 15 minutes
const DOWNLOAD_URL_EXPIRY = parseInt(process.env.R2_DOWNLOAD_URL_EXPIRY) || 3600; // 1 hour

/**
 * Generate a canonical storage key for uploaded files
 * Format: {category}/{date}/{content_hash}.{ext}
 *
 * @param {string} filename - Original filename
 * @param {string} category - Storage category (pods, attachments, etc.)
 * @returns {string} Canonical storage key
 */
function generateStorageKey(filename, category = 'pods') {
  const ext = getFileExtension(filename);
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  const hash = crypto.createHash('md5').update(`${timestamp}${random}`).digest('hex').substring(0, 12);

  // Clean category path
  const cleanCategory = category.replace(/[^a-zA-Z0-9-_/]/g, '').replace(/^\/+|\/+$/g, '');

  return `${cleanCategory}/${date}/${hash}.${ext}`;
}

/**
 * Get file extension from filename
 *
 * @param {string} filename - Original filename
 * @returns {string} File extension (without dot)
 */
function getFileExtension(filename) {
  if (!filename) return 'bin';
  const parts = filename.split('.');
  if (parts.length > 1) {
    return parts.pop().toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
  }
  return 'bin';
}

/**
 * Generate a pre-signed upload URL for direct browser upload
 *
 * @param {string} key - Storage key for the file
 * @param {string} contentType - MIME type of the file
 * @param {number} expiresIn - URL expiration in seconds (default: 15 min)
 * @returns {Promise<{uploadUrl: string, key: string, expiresIn: number}>}
 */
async function getUploadUrl(key, contentType, expiresIn = UPLOAD_URL_EXPIRY) {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(r2, command, { expiresIn });

  return {
    uploadUrl,
    key,
    expiresIn,
  };
}

/**
 * Generate a pre-signed download URL for direct browser download
 *
 * @param {string} key - Storage key of the file
 * @param {number} expiresIn - URL expiration in seconds (default: 1 hour)
 * @returns {Promise<{downloadUrl: string, key: string, expiresIn: number}>}
 */
async function getDownloadUrl(key, expiresIn = DOWNLOAD_URL_EXPIRY) {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
  });

  const downloadUrl = await getSignedUrl(r2, command, { expiresIn });

  return {
    downloadUrl,
    key,
    expiresIn,
  };
}

/**
 * Generate a public (unsigned) URL for publicly accessible files
 *
 * @param {string} key - Storage key of the file
 * @returns {string} Public URL
 */
function getPublicUrl(key) {
  if (!R2_PUBLIC_URL) {
    console.warn('[PresignedURLs] R2_PUBLIC_URL not configured');
    return null;
  }
  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Generate both upload and download URLs in a single call
 *
 * @param {string} filename - Original filename
 * @param {string} contentType - MIME type
 * @param {string} category - Storage category
 * @returns {Promise<{uploadUrl: string, downloadUrl: string, key: string}>}
 */
async function getUploadAndDownloadUrls(filename, contentType, category = 'pods') {
  const key = generateStorageKey(filename, category);
  const [uploadResult, downloadResult] = await Promise.all([
    getUploadUrl(key, contentType),
    getDownloadUrl(key),
  ]);

  return {
    uploadUrl: uploadResult.uploadUrl,
    downloadUrl: downloadResult.downloadUrl,
    key,
    expiresIn: DOWNLOAD_URL_EXPIRY,
  };
}

module.exports = {
  getUploadUrl,
  getDownloadUrl,
  getPublicUrl,
  getUploadAndDownloadUrls,
  generateStorageKey,
  getFileExtension,
  UPLOAD_URL_EXPIRY,
  DOWNLOAD_URL_EXPIRY,
};
