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

Options:
  --scrape-only, -s             Run in scrape-only mode
  --upload-only, -u             Run in upload-only mode
  --help, -h                    Show this help message
  --version, -v                 Show version information

For more information see CLI_USAGE.md
`);
