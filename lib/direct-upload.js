/**
 * Direct Browser Upload Handler
 *
 * Client-side utilities for direct uploads to R2 using pre-signed URLs.
 * This module provides the browser-side code for direct file uploads.
 *
 * Usage in browser:
 *   import { uploadToR2, fetchUploadUrl } from './lib/direct-upload.js';
 *
 *   // Get upload URL from server
 *   async function getUploadUrl(filename, contentType) {
 *     const response = await fetch(`/api/storage/upload-url?filename=${encodeURIComponent(filename)}&contentType=${encodeURIComponent(contentType)}`);
 *     return response.json();
 *   }
 *
 *   // Upload file
 *   const { uploadUrl, key } = await getUploadUrl(file.name, file.type);
 *   await uploadToR2(file, uploadUrl);
 */

/**
 * Upload a file to R2 using a pre-signed URL
 *
 * @param {File} file - File object from input[type="file"]
 * @param {string} uploadUrl - Pre-signed upload URL from server
 * @param {Object} options - Upload options
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<{success: boolean, key: string}>}
 */
async function uploadToR2(file, uploadUrl, options = {}) {
  const { onProgress } = options;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    // Progress handler
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const percentComplete = Math.round((event.loaded / event.total) * 100);
        onProgress(percentComplete);
      }
    });

    // Load complete
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ success: true });
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    // Error handler
    xhr.addEventListener('error', () => {
      reject(new Error('Upload failed - network error'));
    });

    // Abort handler
    xhr.addEventListener('abort', () => {
      reject(new Error('Upload aborted'));
    });

    // Open and send
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.send(file);
  });
}

/**
 * Upload using fetch API (alternative to XHR)
 *
 * @param {File} file - File object
 * @param {string} uploadUrl - Pre-signed upload URL
 * @returns {Promise<{success: boolean}>}
 */
async function uploadToR2Fetch(file, uploadUrl) {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: {
      'Content-Type': file.type,
    },
  });

  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`);
  }

  return { success: true };
}

/**
 * Upload with retry logic
 *
 * @param {File} file - File object
 * @param {string} uploadUrl - Pre-signed upload URL
 * @param {Object} options - Options including retry config
 * @returns {Promise<{success: boolean}>}
 */
async function uploadWithRetry(file, uploadUrl, options = {}) {
  const { maxRetries = 3, retryDelay = 1000, onProgress } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await uploadToR2(file, uploadUrl, { onProgress });
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      console.warn(`Upload attempt ${attempt} failed, retrying...`, error.message);
      await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
    }
  }
}

/**
 * Upload multiple files sequentially
 *
 * @param {File[]} files - Array of File objects
 * @param {Function} getUploadUrlFn - Function to get upload URL for each file
 * @param {Object} options - Upload options
 * @returns {Promise<Array<{file: string, success: boolean, error?: string}>>}
 */
async function uploadMultiple(files, getUploadUrlFn, options = {}) {
  const results = [];

  for (const file of files) {
    try {
      const { uploadUrl, key } = await getUploadUrlFn(file.name, file.type);
      await uploadToR2(file, uploadUrl, options);
      results.push({ file: file.name, success: true, key });
    } catch (error) {
      results.push({ file: file.name, success: false, error: error.message });
    }
  }

  return results;
}

/**
 * Verify upload by checking if file exists (optional)
 *
 * @param {string} key - Storage key
 * @param {string} checkUrl - URL to check (signed download URL)
 * @returns {Promise<boolean>}
 */
async function verifyUpload(key, checkUrl) {
  try {
    const response = await fetch(checkUrl, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Complete upload workflow: get URL, upload, verify
 *
 * @param {File} file - File to upload
 * @param {Function} getSignedUrlsFn - Function to get upload and verify URLs
 * @param {Object} options - Upload options
 * @returns {Promise<{success: boolean, key: string, verified: boolean}>}
 */
async function completeUpload(file, getSignedUrlsFn, options = {}) {
  // Get signed URLs
  const { uploadUrl, downloadUrl, key } = await getSignedUrlsFn(file.name, file.type);

  // Upload
  await uploadToR2(file, uploadUrl, options);

  // Verify (optional, can be skipped for performance)
  let verified = false;
  if (options.verify !== false) {
    verified = await verifyUpload(key, downloadUrl);
  }

  return { success: true, key, verified };
}

module.exports = {
  uploadToR2,
  uploadToR2Fetch,
  uploadWithRetry,
  uploadMultiple,
  verifyUpload,
  completeUpload,
};
