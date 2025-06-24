# Google Drive API Integration for Twitter Image Scraper

## Implementation Summary

The Google Drive API integration has been successfully implemented for the B-Bot Twitter Image Scraper. This integration allows for:

1. Automatic batch uploading of downloaded images to Google Drive
2. Organized folder structure by username and date
3. Duplicate detection and prevention
4. Local file cleanup based on a configurable retention policy

## Components Implemented

### 1. GoogleDriveUploader Class

- **Location**: `/src/utilities/GoogleDriveUploader.ts`
- **Purpose**: Handles all Google Drive API interactions
- **Features**:
  - Service account authentication
  - Hierarchical folder management
  - Batch uploading with error handling
  - Duplicate detection and skipping
  - Comprehensive logging and statistics

### 2. FileCleanup Utility

- **Location**: `/src/utilities/FileCleanup.ts`
- **Purpose**: Manages local file retention policy
- **Features**:
  - Configurable retention period (default: 3 days)
  - Recursive directory cleaning
  - Empty directory removal
  - Error handling and logging

### 3. Configuration Updates

- **Updated**: `ConfigManager.ts` with Google Drive configuration
- **Added**: Google Drive settings to `.env` template
- **Updated**: `ScraperTypes.ts` with new interfaces

### 4. TwitterScraper Integration

- **Updated**: Constructor to initialize Google Drive uploader if enabled
- **Modified**: `downloadImages()` to track downloaded file paths
- **Added**: Google Drive upload after successful downloads
- **Added**: File cleanup functionality

### 5. Documentation

- **Created**: `GOOGLE_DRIVE_SETUP.md` with detailed setup instructions
- **Updated**: Dependencies to include googleapis package

## Configuration

The Google Drive integration can be configured through environment variables:

```
# Google Drive Configuration
GOOGLE_DRIVE_ENABLED=true
GOOGLE_DRIVE_CREDENTIALS_PATH=config/google-service-account.json
GOOGLE_DRIVE_ROOT_FOLDER_ID=your_root_folder_id_here
```

## Folder Structure

The uploaded files are organized in the following structure on Google Drive:

```
/[Root Folder]/
  └─ TwitterScraper/
     └─ [Username]/
        └─ YYYY-MM-DD/
           ├─ image1.jpg
           ├─ image2.jpg
           └─ ...
```

## Error Handling

The implementation includes robust error handling:

1. Google Drive API initialization errors are caught and logged
2. Upload failures for individual files don't halt the batch process
3. Each file gets one retry attempt if the initial upload fails
4. File cleanup errors are isolated and don't affect the main application

## Usage

The Google Drive integration is automatically used if enabled in the configuration. No code changes are required by the end user. The system will:

1. Download images to the local filesystem
2. Batch upload successful downloads to Google Drive
3. Clean up local files older than the configured retention period

Please refer to the `GOOGLE_DRIVE_SETUP.md` file for detailed instructions on how to set up the Google Drive API integration.

## Performance Considerations

- Images are uploaded in batches after each username's downloads are complete
- Duplicate detection prevents unnecessary uploads
- Rate limiting is respected during uploads
- Cleanup operations happen at the end of the scraping process
