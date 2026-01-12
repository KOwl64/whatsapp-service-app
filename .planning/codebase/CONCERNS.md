# Codebase Concerns

**Analysis Date:** 2026-01-12

## Tech Debt

**S3 Sync Not Implemented:**
- File: `normalise.js:255`
- Issue: `syncToS3()` function is a placeholder with only console.log
- Why: Hybrid storage design prepared but AWS SDK not implemented
- Impact: Files stored only locally, no cloud backup
- Fix approach: Install `@aws-sdk/client-s3`, implement actual S3 upload

**Missing `.env.example` Template:**
- Issue: No template for required environment variables
- Why: Variables documented in code comments only
- Impact: New deployments must discover required vars manually
- Fix approach: Create `.env.example` from `config.js` and documentation

**Backup/Orphaned Files:**
- Files: `index.js.BACKUP`, `index.js.NEW`, `index.js.broken`, `service.js.broken`
- Why: Development artifacts left in repository
- Impact: Clutter, potential confusion
- Fix approach: Delete or git rm these files

## Security Considerations

**TLS Certificate Verification Disabled:**
- File: `email.js:34-36`
- Risk: `rejectUnauthorized: false` allows connections to untrusted SMTP servers
- Current mitigation: None - certificates not verified
- Recommendations: Remove `rejectUnauthorized: false` unless corporate firewall requires it

**Missing Input Validation:**
- File: `service.js:62-71` (`sanitizeFilename`)
- Risk: No length limits on filenames, potential buffer issues
- Current mitigation: Basic character replacement
- Recommendations: Add max length validation, limit path depth

**File Write Without Error Handling:**
- File: `service.js:198`
- Code: `fs.writeFileSync(tempPath, media.data, 'base64');`
- Risk: Failure crashes message handler, loses WhatsApp message
- Current mitigation: None
- Recommendations: Wrap in try/catch, log error, mark message as failed

## Performance Bottlenecks

**In-Memory Caches Without Persistence:**
- File: `ocr.js:10` - `ocrCache` Map
- File: `match.js:10-11` - `jobCache` array
- Problem: Cache lost on service restart
- Impact: Repeated OCR processing, slower matching after restart
- Improvement: Persist cache to SQLite or Redis

**Rate Limiting In-Memory Only:**
- File: `email.js:18-19`
- Problem: `sentCount` and `rateLimitWindow` reset on restart
- Impact: No rate limiting after restart, potential to hit SMTP limits
- Improvement: Track counts in SQLite with timestamp

## Fragile Areas

**Service.js Monolith:**
- File: `service.js` (1,487 lines)
- Why fragile: Single file contains WhatsApp client, Express server, all API handlers, pipeline integration
- Common failures: Large file hard to navigate, easy to break unrelated features
- Safe modification: Refactor to separate modules (in progress with `status-endpoints.js`)
- Test coverage: No tests exist

**Pipeline Error Handling:**
- Files: `service.js:162-418` (`processMediaMessage`)
- Why fragile: Single function handles entire 8-stage pipeline, any error affects entire flow
- Common failures: One stage failure can block downstream stages
- Safe modification: Wrap each stage in try/catch, continue pipeline
- Test coverage: No tests exist

## Dependencies at Risk

**whatsapp-web.js ^1.34.2:**
- Risk: Puppeteer-based WhatsApp Web automation is fragile (depends on WhatsApp Web stability)
- Impact: WhatsApp changes can break entire service
- Mitigation: Monitor QR code issues, restart on disconnect
- Migration path: Consider WhatsApp Cloud API for production stability

**tesseract.js ^7.0.0:**
- Risk: OCR accuracy depends on image quality
- Impact: Poor quality POD images may not extract correctly
- Mitigation: Multiple OCR attempts, confidence scoring
- Alternative: Cloud OCR services (AWS Textract, Google Vision)

## Missing Critical Features

**No Test Suite:**
- Problem: No automated tests for any functionality
- Risk: Regressions undetected, refactoring dangerous
- Current workaround: Manual testing only
- Blocks: Safe refactoring, confidence in changes
- Implementation complexity: Medium - need to add Vitest/Jest and write tests

**No Database Backup Strategy:**
- File: `db.js`
- Problem: SQLite file not backed up automatically
- Risk: Data loss on disk failure
- Current workaround: Manual backup via cron
- Implementation: Add auto-backup to `scheduler.js`

**Rate Limiting Per-Server Only:**
- File: `email.js`
- Problem: If multiple instances run, rate limits don't aggregate
- Impact: Could exceed SMTP limits with horizontal scaling
- Mitigation: Single instance deployment
- Alternative: Use Redis for distributed rate limiting

## Test Coverage Gaps

**Core Pipeline Functions:**
- What's not tested: `classify()`, `ocr.extractText()`, `match.findMatch()`, `autoRoute.decide()`
- Risk: Classification and routing logic could regress
- Priority: High
- Difficulty to test: Need to create test fixtures, mock file system

**Database Operations:**
- What's not tested: All CRUD operations in `models.js`
- Risk: Query errors could cause data corruption
- Priority: High
- Difficulty to test: Need in-memory SQLite or mocked DB

**Email Sending:**
- What's not tested: `email.send()`, `emailQueue.process()`
- Risk: Emails not sent or sent incorrectly
- Priority: Medium
- Difficulty to test: Need SMTP test server

---

*Concerns audit: 2026-01-12*
*Update as issues are fixed or new ones discovered*
