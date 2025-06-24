# Google Drive API Troubleshooting Guide

If you're encountering issues with the Google Drive upload functionality, this guide will help you diagnose and fix common problems.

## Using the Debug Command

The scraper includes a built-in debug command to test your Google Drive configuration:

```bash
npm run debug-drive
# or
node dist/index.js --debug-drive
```

This command will:
1. Check your Google Drive configuration
2. Verify your service account credentials
3. Test access to the root folder
4. Attempt to create a test folder
5. Provide detailed error messages if any step fails

## Common Error Messages

### "File not found: ."

This error appears when the root folder ID is invalid or the service account doesn't have permission to access it.

```
Failed to find or create folder: TwitterScraper: File not found: .
```

### "Permission denied"

This error (HTTP 403) indicates that the service account doesn't have permission to access the folder:

```
Error 403: Permission denied. The service account does not have access to this folder.
```

### Credential Issues

```
Google Drive credentials file not found at: config/google-service-account.json
```

## Fixing Root Folder Issues

1. **Check Folder ID Format**

   A valid folder ID looks like: `1ABC123def456GHI789jkl` (not a complete URL)

   - **✅ CORRECT**: `1XYz123AbCdEfGhIjKlM`
   - **❌ WRONG**: `https://drive.google.com/drive/folders/1XYz123AbCdEfGhIjKlM`
   - **❌ WRONG**: `drive.google.com/drive/folders/1XYz123AbCdEfGhIjKlM`

2. **Find Your Folder ID**

   a. Open Google Drive in your browser
   b. Navigate to the folder you want to use
   c. The URL will be: `https://drive.google.com/drive/folders/YOUR_FOLDER_ID_HERE`
   d. Copy only the ID part (after the last forward slash)

3. **Update Your Configuration**

   Edit `config/.env` and update the GOOGLE_DRIVE_ROOT_FOLDER_ID:

   ```
   GOOGLE_DRIVE_ENABLED=true
   GOOGLE_DRIVE_CREDENTIALS_PATH=config/google-service-account.json
   GOOGLE_DRIVE_ROOT_FOLDER_ID=1XYz123AbCdEfGhIjKlM
   ```

## Service Account Permission Issues

1. **Verify Service Account Email**

   Run the debug command to see your service account email address:
   ```bash
   npm run debug-drive
   ```

2. **Share the Folder with Service Account**

   a. Open Google Drive in your browser
   b. Navigate to your root folder
   c. Right-click and select "Share"
   d. Add the service account email (ends with `@*.iam.gserviceaccount.com`)
   e. Give it "Editor" permission
   f. Uncheck "Notify people"
   g. Click "Share"

   ![Share folder with service account](https://i.imgur.com/example.png)

3. **Checking Permissions**

   a. Right-click on your folder in Google Drive
   b. Select "Share"
   c. Verify the service account email is listed with "Editor" access

## Credential File Issues

1. **Check Credential File Location**

   Make sure your `google-service-account.json` file is located at:
   ```
   /Users/jakeorona/B-Bot/config/google-service-account.json
   ```

2. **Verify Credential File Format**

   The JSON file should look like:
   ```json
   {
     "type": "service_account",
     "project_id": "your-project-id",
     "private_key_id": "abc123...",
     "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
     "client_email": "your-service-account@your-project.iam.gserviceaccount.com",
     "client_id": "123456789",
     "auth_uri": "https://accounts.google.com/o/oauth2/auth",
     "token_uri": "https://oauth2.googleapis.com/token",
     "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
     "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/your-service-account%40your-project.iam.gserviceaccount.com"
   }
   ```

3. **Regenerate Service Account Key**

   If your credentials file is corrupt, you can create a new one:
   
   a. Go to [Google Cloud Console](https://console.cloud.google.com/)
   b. Navigate to: IAM & Admin > Service Accounts
   c. Find your service account and click "Manage keys"
   d. Add a new key (JSON type)
   e. Save the file to your config directory

## Google Cloud Project Issues

1. **Enable the Google Drive API**

   a. Go to [Google Cloud Console](https://console.cloud.google.com/)
   b. Navigate to: APIs & Services > Library
   c. Search for "Google Drive API"
   d. Click "Enable"

2. **Check for API Quota Limits**

   a. Go to [Google Cloud Console](https://console.cloud.google.com/)
   b. Navigate to: APIs & Services > Dashboard
   c. Check if you've hit any quota limits

## Test with a Different Folder

If you're still having issues, try creating a new test folder:

1. Create a new folder in Google Drive
2. Share it with your service account email
3. Copy the new folder ID
4. Update your `.env` file with the new ID
5. Run the debug command again

## Still Need Help?

If you've tried all these steps and still can't get it working:

1. Run the debug command and save the output
2. Check the Google Drive API dashboard for any error messages
3. Verify your service account has the right permissions
4. Make sure the Google Drive API is enabled in your project
