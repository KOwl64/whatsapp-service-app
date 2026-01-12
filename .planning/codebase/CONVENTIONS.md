# Coding Conventions

**Analysis Date:** 2026-01-12

## Naming Patterns

**Files:**
- kebab-case for all files (`service.js`, `emailQueue.js`, `legalHold.js`)
- No PascalCase files (even for modules)

**Functions:**
- camelCase for all functions
- No special prefix for async functions
- Descriptive names with full words (`processMediaMessage`, `validateAndProcessFile`)

**Variables:**
- camelCase for variables (`contentHash`, `storagePath`, `correlationId`)
- UPPER_SNAKE_CASE for constants (`POD_MIN_SIZE`, `MAX_FILE_SIZE`, `AUDIT_ACTIONS`)
- No underscore prefix for private members

**Database:**
- snake_case for columns (`content_hash`, `job_ref`, `created_at`)
- snake_case plural for tables (`messages`, `attachments`, `audit_logs`)

**Constants/Enums:**
- PascalCase for exported objects (`AUDIT_ACTIONS`, `ROUTE_TO`)
- UPPER_SNAKE_CASE for values within objects

## Code Style

**Formatting:**
- 4 spaces indentation (observed in all files)
- No formatter configured (no .prettierrc, no .prettierignore)
- Single quotes for strings (`const foo = 'bar'`)
- Semicolons required at statement ends

**Linting:**
- No ESLint configuration found
- No linting rules enforced
- Manual style consistency required

## Import Organization

**Order:**
1. Node.js built-ins (`require('fs')`, `require('path')`, `require('crypto')`)
2. External packages (`require('express')`, `require('tesseract.js')`)
3. Internal modules (`require('./db')`, `require('./models')`)

**Grouping:**
- No enforced blank lines between import groups
- Manual organization observed

**Path Aliases:**
- None defined
- Relative paths for internal imports (`./db`, `../models`)

## Error Handling

**Patterns:**
- Try/catch at function level for async operations
- Errors logged via `console.error()`
- No custom error classes
- Error details passed to audit logging via `logFailed()`

**When to Throw:**
- Fatal errors in initialization (missing config, DB connection)
- File operations that cannot recover
- Unexpected states (violations of assumptions)

**When to Return Error Objects:**
- Pipeline processing failures (classification, OCR, extraction)
- Expected validation failures
- Network errors from external services

**Logging:**
- `console.log()` for operational output
- `console.error()` for errors
- No structured logging library
- Correlation IDs added via audit module

## Comments

**When to Comment:**
- Explain non-obvious logic (regex patterns, threshold decisions)
- Document business rules (routing thresholds, classification rules)
- TODO comments for incomplete implementations

**JSDoc:**
- Used for function documentation
- Format: `/** ... */` with `@param`, `@returns` tags
- Example from `classify.js`:
```javascript
/**
 * Main classification function
 * @param {object} attachmentData - Attachment metadata
 * @returns {object} Classification result
 */
function classify(attachmentData) {
```

**Section Headers:**
- ASCII art style dividers:
```javascript
// ============================================
// Process attachment (image/document)
// ============================================
```

**TODO Comments:**
- Format: `// TODO: description` or `// TODO(username): description`
- Located in `normalise.js:255` for S3 implementation

## Function Design

**Size:**
- Mixed - some functions are long (pipeline handlers in `service.js`)
- Recommendation: Extract helpers for complex logic

**Parameters:**
- Multiple parameters common (up to 5-6)
- Options object pattern emerging for complex functions

**Return Values:**
- Objects with `success`, `error`, and data fields for pipeline stages
- Consistent pattern: `{ success: boolean, error?: string, ...data }`

## Module Design

**Exports:**
- Named exports via `module.exports = { ... }`
- Object with all public functions

**Pattern:**
```javascript
module.exports = {
    functionName,
    anotherFunction,
    CONSTANT_VALUE
};
```

**No barrel files** - all imports are file-specific

---

*Convention analysis: 2026-01-12*
*Update when patterns change*
