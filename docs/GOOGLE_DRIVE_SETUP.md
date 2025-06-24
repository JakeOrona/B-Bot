# Google Drive API Integration Guide

This guide will help you set up the Google Drive API integration for the Twitter Image Scraper.

## Prerequisites

- You must have a Google account
- Basic familiarity with Google Cloud Platform

## Step 1: Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Click on "Select a project" at the top of the page
3. Click "NEW PROJECT"
4. Enter a name for your project (e.g., "Twitter Image Scraper")
5. Click "CREATE"

## Step 2: Enable the Google Drive API

1. In your project, navigate to "APIs & Services" > "Library"
2. Search for "Google Drive API"
3. Click on "Google Drive API" in the results
4. Click "ENABLE"

## Step 3: Create Service Account

1. Navigate to "APIs & Services" > "Credentials"
2. Click "CREATE CREDENTIALS" and select "Service Account"
3. Enter a name for your service account (e.g., "twitter-scraper-service")
4. Click "CREATE AND CONTINUE"
5. For role, select "Project" > "Editor" (or just "Drive API" > "Drive File Creator" for more limited permissions)
6. Click "CONTINUE"
7. You can skip the "Grant users access" step
8. Click "DONE"

## Step 4: Create and Download Service Account Key

1. In the Credentials page, find your service account in the list
2. Click the three dots (⋮) for your service account and select "Manage keys"
3. Click "ADD KEY" > "Create new key"
4. Select "JSON" as the key type
5. Click "CREATE"
6. The key file will be downloaded automatically
7. Move this file to your config directory (e.g., `/config/google-service-account.json`)

## Step 5: Create a Folder in Google Drive

1. Go to [Google Drive](https://drive.google.com/)
2. Create a new folder where you want the images to be uploaded
3. Right-click the folder and select "Share"
4. In the "Share with people and groups" dialog, enter the email address of your service account 
   (it will look like `service-account-name@project-id.iam.gserviceaccount.com`)
5. Make sure the role is set to "Editor"
6. Click "Send"

## Step 6: Get the Folder ID

1. Open the folder in Google Drive
2. Look at the URL in your browser
3. The folder ID is the part of the URL after "folders/" 
   (e.g., in the URL `https://drive.google.com/drive/u/0/folders/1ABCdefGHIjklMNOpqrsTUVwxyz`, 
   the folder ID is `1ABCdefGHIjklMNOpqrsTUVwxyz`)

## Step 7: Update Configuration

1. In your `.env` file, update the following variables:
   ```
   GOOGLE_DRIVE_ENABLED=true
   GOOGLE_DRIVE_CREDENTIALS_PATH=config/google-service-account.json
   GOOGLE_DRIVE_ROOT_FOLDER_ID=your_folder_id_here
   ```

2. Replace `your_folder_id_here` with the folder ID you obtained in Step 6

## How It Works

- Images will be uploaded to a folder structure: `/TwitterScraper/username/YYYY-MM-DD/`
- Duplicates are automatically detected and skipped
- Upload failures are logged but won't stop the scraping process
- Local files older than 3 days are automatically deleted (configurable)
