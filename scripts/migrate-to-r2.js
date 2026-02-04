/**
 * R2 Migration Script
 *
 * Migrates existing POD files from local filesystem to Cloudflare R2 storage.
 *
 * Usage:
 *   node scripts/migrate-to-r2.js              # Run full migration
 *   node scripts/migrate-to-r2.js --dry-run    # Test without uploading
 *   node scripts/migrate-to-r2.js --batch 25   # Process 25 files at a time
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
const STORAGE_BASE_PATH = process.env.STORAGE_BASE_PATH || '/data/whatsapp-pod-pods';
const BATCH_SIZE = parseInt(process.env.MIGRATION_BATCH_SIZE) || 50;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

// Import storage module (will use existing R2 config)
const { uploadFile, getStorageStatus, listFiles } = require('../lib/storage');

// Supported MIME types for POD files
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];

// Files to skip
const SKIP_PATTERNS = ['.DS_Store', '.Thumbs.db', 'desktop.ini', '.metadata'];

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Check if file should be skipped
 */
function shouldSkip(filePath) {
  const basename = path.basename(filePath);
  return SKIP_PATTERNS.some(pattern => basename.includes(pattern));
}

/**
 * Recursively find all files in directory
 */
function findAllFiles(dir) {
  const files = [];

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (!shouldSkip(fullPath)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files.sort();
}

/**
 * Calculate file checksum
 */
function calculateChecksum(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(fileBuffer).digest('hex');
}

/**
 * Upload single file to R2
 */
async function uploadToR2(filePath) {
  const content = fs.readFileSync(filePath);
  const mimeType = getMimeType(filePath);
  const key = path.relative(STORAGE_BASE_PATH, filePath);

  const result = await uploadFile(key, content, mimeType);

  return {
    key,
    mimeType,
    size: content.length,
    checksum: calculateChecksum(filePath),
    uri: result.uri,
    storage: result.storage,
  };
}

/**
 * Process batch of files
 */
async function processBatch(files, startIndex) {
  const batch = files.slice(startIndex, startIndex + BATCH_SIZE);
  const results = {
    success: [],
    failed: [],
  };

  for (const filePath of batch) {
    try {
      const result = await uploadToR2(filePath);
      results.success.push({
        file: filePath,
        ...result,
      });
    } catch (error) {
      results.failed.push({
        file: filePath,
        error: error.message,
      });
    }
  }

  return results;
}

/**
 * Generate migration report
 */
function generateReport(stats) {
  console.log('\n' + '='.repeat(60));
  console.log('MIGRATION REPORT');
  console.log('='.repeat(60));
  console.log(`Total files found: ${stats.total}`);
  console.log(`Total size: ${formatBytes(stats.totalSize)}`);
  console.log(`Dry run: ${DRY_RUN ? 'YES' : 'NO'}`);
  console.log('-'.repeat(60));
  console.log(`Successfully migrated: ${stats.success}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Duration: ${stats.duration}ms`);
  console.log('='.repeat(60));

  if (stats.failedFiles.length > 0) {
    console.log('\nFailed files:');
    stats.failedFiles.forEach((file, i) => {
      console.log(`  ${i + 1}. ${file.file}`);
      console.log(`     Error: ${file.error}`);
    });
  }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('='.repeat(60));
  console.log('R2 Storage Migration Script');
  console.log('='.repeat(60));
  console.log(`Storage base path: ${STORAGE_BASE_PATH}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Dry run: ${DRY_RUN ? 'YES' : 'NO'}`);
  console.log('-'.repeat(60));

  // Check R2 status
  const status = await getStorageStatus();
  console.log(`R2 available: ${status.r2Available}`);
  console.log(`R2 bucket: ${status.r2Bucket}`);

  if (!status.r2Available && !DRY_RUN) {
    console.warn('\nWARNING: R2 is not available. Migration will use local storage only.');
    console.warn('Ensure R2 environment variables are set for proper migration.\n');
  }

  // Find all files
  console.log('\nScanning for files...');
  const allFiles = findAllFiles(STORAGE_BASE_PATH);
  const totalSize = allFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);

  console.log(`Found ${allFiles.length} files (${formatBytes(totalSize)})`);

  if (allFiles.length === 0) {
    console.log('No files to migrate.');
    return;
  }

  // Estimate time
  const estimatedTime = Math.ceil(allFiles.length / BATCH_SIZE) * 100; // ~100ms per batch
  console.log(`Estimated time: ~${estimatedTime / 1000}s (at ${BATCH_SIZE} files/batch)`);

  if (DRY_RUN) {
    console.log('\n--- DRY RUN MODE ---');
    console.log('No files will be uploaded.');
    console.log('Sample files that would be migrated:');
    allFiles.slice(0, 10).forEach(f => {
      console.log(`  - ${path.relative(STORAGE_BASE_PATH, f)}`);
    });
    if (allFiles.length > 10) {
      console.log(`  ... and ${allFiles.length - 10} more`);
    }
    return;
  }

  // Process files in batches
  console.log('\nStarting migration...');
  const startTime = Date.now();
  const stats = {
    total: allFiles.length,
    totalSize,
    success: 0,
    failed: 0,
    skipped: 0,
    failedFiles: [],
    duration: 0,
  };

  let processed = 0;
  while (processed < allFiles.length) {
    const percentage = Math.round((processed / allFiles.length) * 100);
    process.stdout.write(`\rProgress: ${percentage}% (${processed}/${allFiles.length})`);

    const results = await processBatch(allFiles, processed);

    stats.success += results.success.length;
    stats.failed += results.failed.length;
    stats.failedFiles.push(...results.failed);

    processed += results.success.length + results.failed.length;
  }

  stats.duration = Date.now() - startTime;
  process.stdout.write('\rProgress: 100% (100/100)\n');

  // Generate report
  generateReport(stats);

  // Return stats for programmatic use
  return stats;
}

// Export for programmatic use
module.exports = {
  migrate,
  uploadToR2,
  findAllFiles,
  calculateChecksum,
  getMimeType,
};

// Run if called directly
if (require.main === module) {
  migrate()
    .then((stats) => {
      process.exit(stats.failed > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
