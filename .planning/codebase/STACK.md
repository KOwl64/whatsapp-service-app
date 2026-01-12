# Technology Stack

**Analysis Date:** 2026-01-12

## Languages

**Primary:**
- JavaScript (ES2022+) - All application code (`*.js` files)

## Runtime

**Environment:**
- Node.js 18 (Dockerfile: `FROM node:18-slim`)
- No `engines` field specified in package.json

**Package Manager:**
- npm 10.x
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Express.js ^4.22.1 - Web server framework (`index.js`, `service.js`)
- Puppeteer (via whatsapp-web.js) - Headless Chrome for WhatsApp Web automation

**Testing:**
- No test framework configured
- `package.json` shows: `"test": "echo \"Error: no test specified\" && exit 1"`

**Build/Dev:**
- No build tooling (plain JavaScript)
- No bundler required

## Key Dependencies

**Critical:**
- whatsapp-web.js ^1.34.2 - WhatsApp Web API client
- better-sqlite3 ^9.4.3 - SQLite database driver (synchronous, fast)
- express ^4.22.1 - HTTP server framework
- axios ^1.13.2 - HTTP client for external APIs
- nodemailer ^7.0.12 - Email sending via SMTP
- tesseract.js ^7.0.0 - OCR text extraction from images
- node-cron ^4.2.1 - Scheduled job execution
- dotenv ^17.2.3 - Environment variable loading

**Infrastructure:**
- qrcode ^1.5.4 - QR code generation
- qrcode-terminal ^0.12.0 - Terminal QR display for WhatsApp auth

## Configuration

**Environment:**
- Centralized in `config.js` - Configuration module with environment variable overrides
- Default values provided for all settings
- No `.env` or `.env.example` files in repository (managed externally)

**Build:**
- No build configuration files
- Plain JavaScript execution

## Platform Requirements

**Development:**
- macOS/Linux/Windows with Node.js 18+
- No external dependencies for local development

**Production:**
- Docker container (Dockerfile provided)
- WhatsApp Web.js requires system dependencies for Chromium/Puppeteer
- SQLite file storage (no external database required)

---

*Stack analysis: 2026-01-12*
*Update after major dependency changes*
