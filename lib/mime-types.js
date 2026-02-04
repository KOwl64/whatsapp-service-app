/**
 * MIME Type Mapping
 *
 * Maps file extensions to MIME types for R2 uploads.
 * Handles common POD file types and provides fallbacks.
 */

const path = require('path');

/**
 * MIME type mapping for common file extensions
 */
const MIME_TYPES = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',

  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // Text
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',

  // Archives
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',

  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',

  // Video
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',

  // WhatsApp media types
  '.opus': 'audio/ogg; codecs=opus',
  '.aac': 'audio/aac',
  '.mpeg': 'video/mpeg',

  // Fallback
  '.bin': 'application/octet-stream',
};

/**
 * Get MIME type from filename or extension
 *
 * @param {string} filename - Filename or extension (with or without dot)
 * @returns {string} MIME type
 */
function getMimeType(filename) {
  if (!filename) return 'application/octet-stream';

  // Get extension
  const ext = filename.includes('.')
    ? path.extname(filename).toLowerCase()
    : filename.startsWith('.')
      ? filename.toLowerCase()
      : `.${filename.toLowerCase()}`;

  // Return mapped type or fallback
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Get extension from MIME type
 *
 * @param {string} mimeType - MIME type string
 * @returns {string} Extension (with dot) or null if not found
 */
function getExtension(mimeType) {
  for (const [ext, type] of Object.entries(MIME_TYPES)) {
    if (type === mimeType || type.startsWith(mimeType)) {
      return ext;
    }
  }
  return null;
}

/**
 * Check if MIME type is an image
 *
 * @param {string} mimeType - MIME type string
 * @returns {boolean}
 */
function isImage(mimeType) {
  return mimeType.startsWith('image/');
}

/**
 * Check if MIME type is a document
 *
 * @param {string} mimeType - MIME type string
 * @returns {boolean}
 */
function isDocument(mimeType) {
  return (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('application/vnd.openxmlformats') ||
    mimeType.startsWith('application/msword')
  );
}

/**
 * Check if MIME type is audio
 *
 * @param {string} mimeType - MIME type string
 * @returns {boolean}
 */
function isAudio(mimeType) {
  return mimeType.startsWith('audio/');
}

/**
 * Check if MIME type is video
 *
 * @param {string} mimeType - MIME type string
 * @returns {boolean}
 */
function isVideo(mimeType) {
  return mimeType.startsWith('video/');
}

/**
 * Validate MIME type against allowed types
 *
 * @param {string} mimeType - MIME type to validate
 * @param {string[]} allowed - Array of allowed MIME types
 * @returns {boolean}
 */
function isAllowed(mimeType, allowed = []) {
  if (allowed.length === 0) return true;
  return allowed.some((type) => {
    if (type.endsWith('/*')) {
      return mimeType.startsWith(type.replace('/*', '/'));
    }
    return mimeType === type;
  });
}

/**
 * Common POD file MIME types for validation
 */
const POD_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
];

/**
 * Validate if file is a valid POD type
 *
 * @param {string} mimeType - MIME type to check
 * @returns {boolean}
 */
function isValidPodType(mimeType) {
  return isAllowed(mimeType, POD_ALLOWED_MIME_TYPES);
}

module.exports = {
  getMimeType,
  getExtension,
  isImage,
  isDocument,
  isAudio,
  isVideo,
  isAllowed,
  isValidPodType,
  POD_ALLOWED_MIME_TYPES,
  MIME_TYPES,
};
