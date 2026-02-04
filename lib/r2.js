/**
 * Cloudflare R2 S3-compatible Client Configuration
 *
 * Uses @aws-sdk/client-s3 with R2-specific endpoint configuration.
 * Region must be 'auto' for R2 compatibility.
 */

const { S3Client } = require('@aws-sdk/client-s3');

/**
 * R2 Client Instance
 * Configured for Cloudflare R2 S3-compatible API
 */
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * R2 Configuration Constants
 */
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'whatsapp-pods';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

/**
 * Test R2 connection on startup
 * Lists objects in bucket to verify credentials work
 */
async function testR2Connection() {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

  try {
    const command = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      MaxKeys: 1,
    });

    await r2.send(command);
    console.log('[R2] Connection successful - bucket accessible');
    return true;
  } catch (error) {
    if (error.name === 'NoSuchBucket') {
      console.log('[R2] Bucket does not exist yet - will be created on first upload');
      return true;
    }
    console.log('[R2] Connection failed:', error.message);
    return false;
  }
}

module.exports = {
  r2,
  R2_BUCKET,
  R2_PUBLIC_URL,
  testR2Connection,
};
