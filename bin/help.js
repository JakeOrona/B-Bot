#!/usr/bin/env node

/**
 * Command line help script for Twitter Image Scraper
 */

console.log(`
Twitter Image Scraper - Command Line Interface

Usage:
  npm start                      Run full process (scrape + upload)
  npm run scrape                 Run in scrape-only mode (no uploads)
  npm run upload                 Run in upload-only mode (upload existing images)
  npm run debug-drive            Test Google Drive configuration

Options:
  --scrape-only, -s             Run in scrape-only mode
  --upload-only, -u             Run in upload-only mode
  --debug-drive, -d             Test Google Drive configuration
  --help, -h                    Show this help message
  --version, -v                 Show version information

Configuration:
  UPLOAD_BATCH_SIZE             Number of images to upload per batch (default: 10)
  MAX_CONCURRENT_UPLOADS        Maximum concurrent uploads (default: 3)

For more information see:
  - CLI_USAGE.md                Command line usage
  - GOOGLE_DRIVE_TROUBLESHOOTING.md   Google Drive setup help
  - ASYNC_UPLOAD_FEATURE.md     Batch upload optimization details
`);
