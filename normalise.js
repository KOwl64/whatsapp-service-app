const fs = require('fs');
const path = require('path');

const STORAGE_DIR = './pod_storage';

function ensureStorageDirectories() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function validateAndProcessFile(tempPath, options) {
  return {
    storagePath: 'pod_' + Date.now() + '.dat',
    contentHash: 'stub_hash',
    fileType: 'image/jpeg'
  };
}

function moveToStorage(tempPath, storagePath) {
  // Stub - just copy
}

function generateStorageUri(storagePath) {
  return storagePath;
}

module.exports = {
  init: () => {},
  ensureStorageDirectories,
  validateAndProcessFile,
  moveToStorage,
  generateStorageUri,
  process: (text) => text
};
