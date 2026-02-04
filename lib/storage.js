/**
 * Storage Abstraction Layer
 *
 * Unified interface for file storage operations supporting:
 * - Cloudflare R2 (primary remote storage)
 * - Local filesystem (fallback and hybrid mode)
 *
 * Maps local paths to R2 keys for seamless hybrid operation.
 */

const fs = require('fs');
const path = require('path');
const {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');

const { r2, R2_BUCKET, R2_PUBLIC_URL, testR2Connection } = require('./r2');

// Configuration
const LOCAL_STORAGE_BASE = process.env.STORAGE_BASE_PATH || '/data/whatsapp-pod-pods';
let r2Available = false;

// Dual-write configuration
const DUAL_WRITE = process.env.R2_DUAL_WRITE === 'true';
const R2_READ_PRIMARY = process.env.R2_READ_PRIMARY === 'true';
const R2_MIGRATION_MODE = process.env.R2_MIGRATION_MODE || 'hybrid'; // 'hybrid', 'r2-only', 'local-only'

// Metrics tracking
const metrics = {
  r2Uploads: { success: 0, failed: 0 },
  localUploads: { success: 0, failed: 0 },
  r2Downloads: { success: 0, failed: 0 },
  localDownloads: { success: 0, failed: 0 },
  fallbacks: 0,
};

// Initialize R2 connection test
(async () => {
  if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) {
    r2Available = await testR2Connection();
  } else {
    console.log('[Storage] R2 not configured - using local storage only');
  }
})();

/**
 * Map local path to R2 key
 * /data/whatsapp-pods/123.jpg -> pods/123.jpg
 *
 * @param {string} localPath - Full local filesystem path
 * @returns {string} R2 object key
 */
function localPathToR2Key(localPath) {
  // Normalize path
  const normalized = path.normalize(localPath);

  // Remove local storage base path if present
  let key = normalized;
  if (normalized.startsWith(LOCAL_STORAGE_BASE)) {
    key = normalized.substring(LOCAL_STORAGE_BASE.length + 1);
  }

  // Remove leading slashes
  key = key.replace(/^\/+/, '');

  return key;
}

/**
 * Upload file to local storage (helper for dual-write)
 *
 * @param {string} filePath - Local filesystem path
 * @param {Buffer|string} content - File content or path to file
 * @param {string} contentType - MIME type
 * @returns {Promise<{success: boolean, uri: string}>}
 */
async function localUpload(filePath, content, contentType) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(LOCAL_STORAGE_BASE, filePath);
  const dir = path.dirname(absolutePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const contentBuffer = Buffer.isBuffer(content) ? content : fs.readFileSync(content);
  fs.writeFileSync(absolutePath, contentBuffer);

  const uri = `file://${absolutePath}`;
  console.log(`[Storage] Saved locally: ${absolutePath}`);

  return {
    success: true,
    uri,
    path: absolutePath,
  };
}

/**
 * Upload file to R2 storage (helper for dual-write)
 *
 * @param {string} r2Key - R2 object key
 * @param {Buffer} content - File content
 * @param {string} contentType - MIME type
 * @returns {Promise<{success: boolean, uri: string}>}
 */
async function r2Upload(r2Key, content, contentType) {
  const body = Buffer.isBuffer(content) ? content : fs.readFileSync(content);

  const upload = new Upload({
    client: r2,
    params: {
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: body,
      ContentType: contentType,
    },
    queueSize: 4,
    partSize: 1024 * 1024 * 5, // 5MB parts
    leavePartsOnError: false,
  });

  await upload.done();

  const uri = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${r2Key}` : `s3://${R2_BUCKET}/${r2Key}`;
  console.log(`[Storage] Uploaded to R2: ${r2Key}`);

  return {
    success: true,
    uri,
    key: r2Key,
  };
}

/**
 * Upload file to storage (R2 with local fallback and dual-write support)
 *
 * @param {string} filePath - Local filesystem path
 * @param {Buffer|string} content - File content or path to file
 * @param {string} contentType - MIME type
 * @returns {Promise<{success: boolean, uri: string, storage: string}>}
 */
async function uploadFile(filePath, content, contentType = 'application/octet-stream') {
  const r2Key = localPathToR2Key(filePath);
  const contentBuffer = Buffer.isBuffer(content) ? content : fs.readFileSync(content);

  // Determine storage strategy based on migration mode
  const writeToR2 = r2Available && (R2_MIGRATION_MODE === 'r2-only' || R2_MIGRATION_MODE === 'hybrid' || DUAL_WRITE);
  const writeToLocal = R2_MIGRATION_MODE !== 'r2-only';

  // Track results
  const results = { r2: null, local: null };

  // Write to R2 if enabled
  if (writeToR2) {
    try {
      results.r2 = await r2Upload(r2Key, contentBuffer, contentType);
      metrics.r2Uploads.success++;
    } catch (error) {
      console.error(`[Storage] R2 upload failed: ${error.message}`);
      metrics.r2Uploads.failed++;
    }
  }

  // Write to local if enabled
  if (writeToLocal) {
    try {
      results.local = await localUpload(filePath, contentBuffer, contentType);
      metrics.localUploads.success++;
    } catch (error) {
      console.error(`[Storage] Local upload failed: ${error.message}`);
      metrics.localUploads.failed++;
    }
  }

  // Determine primary storage for return value
  // Priority: R2 (if write succeeded) > Local (if write succeeded) > R2 (even if failed) > Local
  if (results.r2?.success) {
    return {
      success: true,
      uri: results.r2.uri,
      storage: 'r2',
      key: r2Key,
      dualWrite: !!results.local?.success,
    };
  }

  if (results.local?.success) {
    return {
      success: true,
      uri: results.local.uri,
      storage: 'local',
      path: results.local.path,
      dualWrite: !!results.r2?.success,
    };
  }

  // Both failed - throw error
  throw new Error('Failed to upload file to both R2 and local storage');
}

/**
 * Download file from local storage (helper for dual-write)
 *
 * @param {string} filePath - Local path or R2 key
 * @returns {Promise<{stream: Readable, storage: string}>}
 */
async function localDownload(filePath) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(LOCAL_STORAGE_BASE, filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const stream = fs.createReadStream(absolutePath);
  return { stream, storage: 'local' };
}

/**
 * Download file from R2 storage (helper for dual-write)
 *
 * @param {string} r2Key - R2 object key
 * @returns {Promise<{stream: Readable, storage: string}>}
 */
async function r2Download(r2Key) {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: r2Key,
  });

  const response = await r2.send(command);
  return { stream: response.Body, storage: 'r2' };
}

/**
 * Download file from storage
 *
 * @param {string} filePath - Local path or R2 key
 * @returns {Promise<{stream: Readable, storage: string}>}
 */
async function downloadFile(filePath) {
  const r2Key = localPathToR2Key(filePath);

  // Strategy: R2 first if configured for R2 primary read
  if (r2Available && R2_READ_PRIMARY) {
    try {
      const result = await r2Download(r2Key);
      metrics.r2Downloads.success++;
      return result;
    } catch (error) {
      if (error.name !== 'NoSuchKey') {
        console.warn(`[Storage] R2 download failed: ${error.message}`);
      }
      metrics.r2Downloads.failed++;
      console.log('[Storage] Falling back to local storage...');
      metrics.fallbacks++;
    }
  }

  // Try R2 first (default behavior)
  if (r2Available) {
    try {
      const result = await r2Download(r2Key);
      metrics.r2Downloads.success++;
      return result;
    } catch (error) {
      if (error.name !== 'NoSuchKey') {
        console.warn(`[Storage] R2 download failed: ${error.message}`);
      }
      metrics.r2Downloads.failed++;
      console.log('[Storage] Falling back to local storage...');
      metrics.fallbacks++;
    }
  }

  // Fallback to local filesystem
  try {
    const result = await localDownload(filePath);
    metrics.localDownloads.success++;
    return result;
  } catch (error) {
    metrics.localDownloads.failed++;
    throw error;
  }
}

/**
 * Delete file from storage
 *
 * @param {string} filePath - Local path or R2 key
 * @returns {Promise<{success: boolean, storage: string}>}
 */
async function deleteFile(filePath) {
  const r2Key = localPathToR2Key(filePath);

  // Try R2 first if available
  if (r2Available) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
      });

      await r2.send(command);
      console.log(`[Storage] Deleted from R2: ${r2Key}`);

      return {
        success: true,
        storage: 'r2',
      };
    } catch (error) {
      console.error(`[Storage] R2 delete failed: ${error.message}`);
    }
  }

  // Fallback to local filesystem
  try {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(LOCAL_STORAGE_BASE, filePath);

    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
      console.log(`[Storage] Deleted locally: ${absolutePath}`);
    }

    return {
      success: true,
      storage: 'local',
    };
  } catch (error) {
    console.error(`[Storage] Local delete failed: ${error.message}`);
    throw new Error(`Failed to delete file: ${error.message}`);
  }
}

/**
 * Check if file exists in storage
 *
 * @param {string} filePath - Local path or R2 key
 * @returns {Promise<{exists: boolean, storage: string}>}
 */
async function fileExists(filePath) {
  const r2Key = localPathToR2Key(filePath);

  // Check R2 first if available
  if (r2Available) {
    try {
      const command = new HeadObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
      });

      await r2.send(command);
      return {
        exists: true,
        storage: 'r2',
      };
    } catch (error) {
      if (error.name !== 'NotFound') {
        console.error(`[Storage] R2 exists check failed: ${error.message}`);
      }
    }
  }

  // Check local filesystem
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(LOCAL_STORAGE_BASE, filePath);
  const exists = fs.existsSync(absolutePath);

  return {
    exists,
    storage: exists ? 'local' : null,
  };
}

/**
 * Get file URL (public or signed)
 *
 * @param {string} filePath - Local path or R2 key
 * @param {number} expiresIn - URL expiration in seconds (default: 3600)
 * @returns {Promise<string>} URL for file access
 */
async function getFileUrl(filePath, expiresIn = 3600) {
  const r2Key = localPathToR2Key(filePath);

  // Use public URL if configured
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL}/${r2Key}`;
  }

  // Generate signed URL for private access
  if (r2Available) {
    try {
      const command = new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
      });

      return await getSignedUrl(r2, command, { expiresIn });
    } catch (error) {
      console.error(`[Storage] Signed URL generation failed: ${error.message}`);
    }
  }

  // Fallback to local file URL
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(LOCAL_STORAGE_BASE, filePath);
  return `file://${absolutePath}`;
}

/**
 * List files in storage directory
 *
 * @param {string} directory - Directory path (relative to storage base)
 * @param {number} maxKeys - Maximum number of keys to return
 * @returns {Promise<Array<{key: string, size: number, lastModified: Date}>>}
 */
async function listFiles(directory = '', maxKeys = 100) {
  const r2Prefix = directory ? localPathToR2Key(directory) : '';

  // Try R2 first if available
  if (r2Available) {
    try {
      const command = new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: r2Prefix,
        MaxKeys: maxKeys,
      });

      const response = await r2.send(command);

      return (response.Contents || []).map((obj) => ({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified,
      }));
    } catch (error) {
      console.error(`[Storage] R2 list failed: ${error.message}`);
    }
  }

  // Fallback to local filesystem
  const absolutePath = path.join(LOCAL_STORAGE_BASE, directory);

  if (!fs.existsSync(absolutePath)) {
    return [];
  }

  const files = fs.readdirSync(absolutePath, { withFileTypes: true });
  const result = [];

  for (const file of files) {
    if (file.isFile()) {
      const filePath = path.join(absolutePath, file.name);
      const stats = fs.statSync(filePath);

      result.push({
        key: path.join(directory, file.name),
        size: stats.size,
        lastModified: stats.mtime,
      });
    }
  }

  return result;
}

/**
 * Get storage status
 *
 * @returns {Promise<{r2Available: boolean, localStorageBase: string}>}
 */
async function getStorageStatus() {
  return {
    r2Available,
    r2Bucket: R2_BUCKET,
    r2Configured: !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID),
    localStorageBase: LOCAL_STORAGE_BASE,
    r2PublicUrlConfigured: !!R2_PUBLIC_URL,
    dualWrite: DUAL_WRITE,
    r2ReadPrimary: R2_READ_PRIMARY,
    migrationMode: R2_MIGRATION_MODE,
  };
}

/**
 * Get storage metrics
 *
 * @returns {Object} Metrics for dual-write monitoring
 */
function getMetrics() {
  return {
    r2Uploads: { ...metrics.r2Uploads },
    localUploads: { ...metrics.localUploads },
    r2Downloads: { ...metrics.r2Downloads },
    localDownloads: { ...metrics.localDownloads },
    fallbacks: metrics.fallbacks,
    uptime: process.uptime(),
  };
}

/**
 * Reset metrics
 */
function resetMetrics() {
  metrics.r2Uploads = { success: 0, failed: 0 };
  metrics.localUploads = { success: 0, failed: 0 };
  metrics.r2Downloads = { success: 0, failed: 0 };
  metrics.localDownloads = { success: 0, failed: 0 };
  metrics.fallbacks = 0;
}

module.exports = {
  uploadFile,
  downloadFile,
  deleteFile,
  fileExists,
  getFileUrl,
  listFiles,
  getStorageStatus,
  getMetrics,
  resetMetrics,
  localPathToR2Key,
  // Expose for testing and migration
  localUpload,
  r2Upload,
  localDownload,
  r2Download,
};
