/**
 * Database Migration Script for R2 Storage
 *
 * Adds R2-related columns to the attachments table and updates existing records
 * with R2 keys and URLs.
 *
 * Usage:
 *   node scripts/migrate-db.js              # Run migration
 *   node scripts/migrate-db.js --verify    # Verify migration without changes
 *   node scripts/migrate-db.js --rollback  # Rollback R2 columns (NOT data)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Configuration
const DB_PATH = process.env.SQLITE_DB_PATH || './pod.db';
const R2_BUCKET = process.env.R2_BUCKET || 'turners-pods';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';
const R2_PREFIX = process.env.R2_KEY_PREFIX || 'pods';

const VERIFY_ONLY = process.argv.includes('--verify') || process.env.VERIFY_ONLY === 'true';
const ROLLBACK = process.argv.includes('--rollback') || process.env.ROLLBACK === 'true';

/**
 * Check if R2 columns already exist
 */
function hasR2Columns(db) {
  const tableInfo = db.pragma('table_info(attachments)');
  const columns = tableInfo.map(col => col.name);
  return {
    hasR2Key: columns.includes('r2_key'),
    hasR2Url: columns.includes('r2_url'),
    hasMigratedAt: columns.includes('migrated_at'),
    hasAll: columns.includes('r2_key') && columns.includes('r2_url') && columns.includes('migrated_at'),
  };
}

/**
 * Get R2 URL for a file
 */
function getR2Url(filename) {
  const key = `${R2_PREFIX}/${filename}`;
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL}/${key}`;
  }
  return `s3://${R2_BUCKET}/${key}`;
}

/**
 * Add R2 columns to attachments table
 */
function addR2Columns(db) {
  console.log('Adding R2 columns to attachments table...');

  try {
    db.exec(`ALTER TABLE attachments ADD COLUMN r2_key TEXT`);
    console.log('  - Added r2_key column');
  } catch (error) {
    if (!error.message.includes('duplicate column name')) {
      throw error;
    }
    console.log('  - r2_key column already exists');
  }

  try {
    db.exec(`ALTER TABLE attachments ADD COLUMN r2_url TEXT`);
    console.log('  - Added r2_url column');
  } catch (error) {
    if (!error.message.includes('duplicate column name')) {
      throw error;
    }
    console.log('  - r2_url column already exists');
  }

  try {
    db.exec(`ALTER TABLE attachments ADD COLUMN migrated_at DATETIME`);
    console.log('  - Added migrated_at column');
  } catch (error) {
    if (!error.message.includes('duplicate column name')) {
      throw error;
    }
    console.log('  - migrated_at column already exists');
  }
}

/**
 * Update existing records with R2 data
 */
function updateRecordsWithR2Data(db) {
  console.log('\nUpdating existing records with R2 data...');

  const stmt = db.prepare(`
    UPDATE attachments
    SET r2_key = ?,
        r2_url = ?,
        migrated_at = datetime('now')
    WHERE r2_key IS NULL
  `);

  // Get all records that haven't been migrated
  const records = db.prepare(`
    SELECT id, storage_uri, canonical_filename
    FROM attachments
    WHERE r2_key IS NULL
  `).all();

  console.log(`  Found ${records.length} records to update`);

  if (VERIFY_ONLY) {
    console.log('  (VERIFICATION MODE - no changes made)');
    return records.length;
  }

  let updated = 0;
  for (const record of records) {
    // Extract filename from storage_uri
    let filename = record.canonical_filename;
    if (!filename && record.storage_uri) {
      filename = path.basename(record.storage_uri);
    }

    if (filename) {
      const r2Key = `${R2_PREFIX}/${filename}`;
      const r2Url = getR2Url(filename);

      stmt.run(r2Key, r2Url);
      updated++;
    }
  }

  console.log(`  Updated ${updated} records`);
  return updated;
}

/**
 * Verify migration integrity
 */
function verifyMigration(db) {
  console.log('\n' + '='.repeat(60));
  console.log('MIGRATION VERIFICATION');
  console.log('='.repeat(60));

  const colStatus = hasR2Columns(db);
  console.log('\nColumn status:');
  console.log(`  r2_key: ${colStatus.hasR2Key ? 'EXISTS' : 'MISSING'}`);
  console.log(`  r2_url: ${colStatus.hasR2Url ? 'EXISTS' : 'MISSING'}`);
  console.log(`  migrated_at: ${colStatus.hasMigratedAt ? 'EXISTS' : 'MISSING'}`);

  // Count records
  const totalRecords = db.prepare('SELECT COUNT(*) as count FROM attachments').get().count;
  const migratedRecords = db.prepare("SELECT COUNT(*) as count FROM attachments WHERE r2_key IS NOT NULL").get().count;
  const unmigratedRecords = db.prepare("SELECT COUNT(*) as count FROM attachments WHERE r2_key IS NULL").get().count;

  console.log('\nRecord status:');
  console.log(`  Total records: ${totalRecords}`);
  console.log(`  Migrated: ${migratedRecords}`);
  console.log(`  Pending: ${unmigratedRecords}`);

  // Sample of migrated records
  if (migratedRecords > 0) {
    console.log('\nSample migrated records:');
    const samples = db.prepare(`
      SELECT id, r2_key, r2_url, migrated_at
      FROM attachments
      WHERE r2_key IS NOT NULL
      LIMIT 5
    `).all();

    samples.forEach((record, i) => {
      console.log(`  ${i + 1}. ID: ${record.id}`);
      console.log(`     Key: ${record.r2_key}`);
      console.log(`     URL: ${record.r2_url}`);
      console.log(`     Migrated: ${record.migrated_at}`);
    });
  }

  console.log('\n' + '='.repeat(60));

  if (!colStatus.hasAll) {
    console.log('\nWARNING: Not all R2 columns exist. Migration needed.');
    return false;
  }

  if (unmigratedRecords > 0) {
    console.log(`\n${unmigratedRecords} records still need migration.`);
    return false;
  }

  console.log('\nMigration verified successfully!');
  return true;
}

/**
 * Check for orphaned local files
 */
function checkOrphanedFiles(db) {
  console.log('\nChecking for orphaned local files...');

  const attachments = db.prepare(`
    SELECT storage_uri, canonical_filename
    FROM attachments
    WHERE storage_uri LIKE 'file://%'
  `).all();

  let orphaned = 0;
  const missingFiles = [];

  for (const record of attachments) {
    const filePath = record.storage_uri.replace('file://', '');

    if (!fs.existsSync(filePath)) {
      orphaned++;
      if (missingFiles.length < 5) {
        missingFiles.push(filePath);
      }
    }
  }

  if (orphaned > 0) {
    console.log(`  Found ${orphaned} attachments with missing local files`);
    if (missingFiles.length > 0) {
      console.log('  Sample missing files:');
      missingFiles.forEach(f => console.log(`    - ${f}`));
    }
  } else {
    console.log('  All local files present');
  }

  return orphaned;
}

/**
 * Rollback R2 columns
 */
function rollbackR2Columns(db) {
  console.log('\nROLLBACK MODE');
  console.log('Note: This only removes the R2 columns, not the data itself.');

  // SQLite doesn't support DROP COLUMN in older versions
  // We need to recreate the table
  console.log('  Creating backup table...');
  db.exec(`CREATE TABLE IF NOT EXISTS attachments_backup AS SELECT * FROM attachments`);

  console.log('  Dropping original table...');
  db.exec('DROP TABLE attachments');

  console.log('  Recreating without R2 columns...');
  db.exec(`
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      content_hash TEXT UNIQUE,
      file_type TEXT,
      file_size INTEGER,
      original_filename TEXT,
      storage_uri TEXT NOT NULL,
      canonical_filename TEXT,
      status TEXT DEFAULT 'REVIEW',
      job_ref TEXT,
      vehicle_reg TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      metadata TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `);

  console.log('  Copying data back...');
  db.exec(`
    INSERT INTO attachments (id, message_id, content_hash, file_type, file_size,
                            original_filename, storage_uri, canonical_filename,
                            status, job_ref, vehicle_reg, created_at, metadata)
    SELECT id, message_id, content_hash, file_type, file_size,
           original_filename, storage_uri, canonical_filename,
           status, job_ref, vehicle_reg, created_at, metadata
    FROM attachments_backup
  `);

  console.log('  Dropping backup table...');
  db.exec('DROP TABLE attachments_backup');

  console.log('  Recreating indexes...');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attachments_status ON attachments(status);
    CREATE INDEX IF NOT EXISTS idx_attachments_content_hash ON attachments(content_hash);
  `);

  console.log('\nRollback complete. R2 columns removed.');
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('='.repeat(60));
  console.log('R2 Database Migration Script');
  console.log('='.repeat(60));
  console.log(`Database: ${DB_PATH}`);
  console.log(`R2 Bucket: ${R2_BUCKET}`);
  console.log(`R2 Prefix: ${R2_PREFIX}`);
  console.log(`R2 Public URL: ${R2_PUBLIC_URL || '(not configured)'}`);
  console.log(`Mode: ${VERIFY_ONLY ? 'VERIFY' : ROLLBACK ? 'ROLLBACK' : 'MIGRATE'}`);
  console.log('-'.repeat(60));

  if (ROLLBACK) {
    rollbackR2Columns(new Database(DB_PATH));
    return;
  }

  if (VERIFY_ONLY) {
    const db = new Database(DB_PATH);
    verifyMigration(db);
    checkOrphanedFiles(db);
    db.close();
    return;
  }

  // Run migration
  const db = new Database(DB_PATH);

  // Check current state
  const colStatus = hasR2Columns(db);

  if (colStatus.hasAll) {
    console.log('\nR2 columns already exist. Checking if update needed...');
    const pending = db.prepare("SELECT COUNT(*) as count FROM attachments WHERE r2_key IS NULL").get().count;

    if (pending === 0) {
      console.log('All records already migrated. Running verification...');
      verifyMigration(db);
      db.close();
      return;
    }

    console.log(`${pending} records still need R2 data. Updating...`);
    updateRecordsWithR2Data(db);
  } else {
    console.log('\nAdding R2 columns...');
    addR2Columns(db);

    console.log('\nPopulating R2 data for existing records...');
    updateRecordsWithR2Data(db);
  }

  // Verify migration
  verifyMigration(db);

  // Check for orphaned files
  checkOrphanedFiles(db);

  db.close();
  console.log('\nMigration complete!');
}

// Export for programmatic use
module.exports = {
  migrate,
  addR2Columns,
  updateRecordsWithR2Data,
  verifyMigration,
  checkOrphanedFiles,
  hasR2Columns,
};

// Run if called directly
if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
