# Twitter Image Scraper - CLI Usage

The Twitter Image Scraper now supports three operational modes through a Command Line Interface (CLI).

## Available Modes

### Full Flow Mode (Default)

This mode performs the complete process: scraping images from Twitter/X profiles and uploading them to Google Drive (if enabled).

```bash
# Using npm script
npm start

# Or using node directly
node dist/index.js
```

### Scrape-Only Mode

This mode scrapes images from Twitter/X profiles but skips the Google Drive upload step.

```bash
# Using npm script
npm run scrape

# Or using CLI options
node dist/index.js --scrape-only
# Short form
node dist/index.js -s
```

### Upload-Only Mode

This mode skips the scraping process and only uploads existing images from the download directory to Google Drive. Useful for retrying uploads or uploading previously downloaded images.

```bash
# Using npm script
npm run upload

# Or using CLI options
node dist/index.js --upload-only
# Short form
node dist/index.js -u
```

## Additional CLI Options

```bash
# Display help information
node dist/index.js --help

# Display version information
node dist/index.js --version
```

## Configuration

All modes use the same configuration files:

- `config/auth.json` - Twitter authentication credentials
- `config/artists.json` - List of Twitter usernames to scrape
- `config/scraper.json` - Scraper configuration options
- `config/googleDrive.json` - Google Drive configuration (if enabled)

## Examples

### Run the full flow (scrape + upload)

```bash
npm start
```

### Scrape images without uploading to Google Drive

```bash
npm run scrape
```

### Upload previously downloaded images to Google Drive

```bash
npm run upload
```
