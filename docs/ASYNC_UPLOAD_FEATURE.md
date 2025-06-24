# Asynchronous Batch Upload Feature

The Twitter Image Scraper now includes an optimized asynchronous batch upload feature to improve performance and reduce overall processing time.

## How It Works

Instead of the traditional sequential approach (download all images first, then upload them all), the new feature implements concurrent operations:

1. Images are downloaded sequentially as before
2. After every 10 images (configurable batch size), an upload process begins
3. Downloads continue while uploads are happening in the background
4. Multiple uploads can run concurrently (limited to 3 by default)
5. Progress of both downloads and uploads is tracked and reported

## Configuration Options

In your `config/.env` file, you can adjust the following settings:

```
# Upload Configuration
UPLOAD_BATCH_SIZE=10      # Number of images per batch upload
MAX_CONCURRENT_UPLOADS=3  # Maximum number of concurrent uploads
```

## Performance Benefits

This approach offers several performance advantages:

1. **Reduced Total Processing Time**: Uploads begin before all downloads are complete
2. **Resource Utilization**: Better utilization of network resources by running downloads and uploads in parallel
3. **Immediate Feedback**: Upload progress is reported in real-time as batches complete
4. **Memory Efficiency**: Only processes a small batch of images at once instead of all at once
5. **Resilience**: If an upload batch fails, it doesn't affect other batches

## Implementation Details

The implementation uses:

- Promise-based concurrency for managing uploads
- A queue system to limit the number of concurrent uploads
- Granular progress tracking for both downloads and uploads
- Comprehensive error handling that keeps the process running even if some operations fail

## Example Output

```
[INFO] Downloaded 10/57 images for @artist1
[INFO] Starting async upload of batch 1 (10 files) for @artist1
[INFO] Downloaded 20/57 images for @artist1
[INFO] Starting async upload of batch 2 (10 files) for @artist1
[INFO] Downloaded 30/57 images for @artist1
[SUCCESS] Batch 1 upload completed for @artist1: 10/10 successful, 0 failed, 0 skipped
[INFO] Starting async upload of batch 3 (10 files) for @artist1
[INFO] Progress: 30/57 downloaded, 10 uploaded across 1 completed batches
[INFO] Downloaded 40/57 images for @artist1
[SUCCESS] Batch 2 upload completed for @artist1: 10/10 successful, 0 failed, 0 skipped
[INFO] Starting async upload of batch 4 (10 files) for @artist1
[INFO] Progress: 40/57 downloaded, 20 uploaded across 2 completed batches
[INFO] Downloaded 50/57 images for @artist1
[SUCCESS] Batch 3 upload completed for @artist1: 10/10 successful, 0 failed, 0 skipped
[INFO] Starting async upload of batch 5 (10 files) for @artist1
[INFO] Progress: 50/57 downloaded, 30 uploaded across 3 completed batches
[INFO] Downloaded 57/57 images for @artist1
[SUCCESS] Batch 4 upload completed for @artist1: 10/10 successful, 0 failed, 0 skipped
[INFO] Starting async upload of batch 6 (7 files) for @artist1
[INFO] Progress: 57/57 downloaded, 40 uploaded across 4 completed batches
[SUCCESS] Batch 5 upload completed for @artist1: 10/10 successful, 0 failed, 0 skipped
[INFO] Progress: 57/57 downloaded, 50 uploaded across 5 completed batches
[SUCCESS] Batch 6 upload completed for @artist1: 7/7 successful, 0 failed, 0 skipped
[INFO] Progress: 57/57 downloaded, 57 uploaded across 6 completed batches
[SUCCESS] Completed downloading images for @artist1: 57 downloaded successfully, 0 download failures, 0 skipped
[SUCCESS] All uploads completed for @artist1: 57 uploaded successfully, 0 upload failures, 0 skipped
```

## Error Handling

The system is designed to be resilient to failures:

- If a download fails, it's logged and the process continues
- If an upload batch fails, it's logged but doesn't affect other uploads
- All errors are properly reported while allowing the process to continue

## Technical Implementation

The feature is implemented using:

- A queue system to manage pending uploads
- Promise-based concurrency with Promise.allSettled
- Batch copying to prevent race conditions
- Progress tracking by batch ID
- Aggregate statistics for final reporting
