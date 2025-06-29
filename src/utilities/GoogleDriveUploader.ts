/**
 * GoogleDriveUploader: Utility for uploading images to Google Drive
 * Uses Service Account authentication to manage uploads
 */

import { google, drive_v3 } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { Logger } from './Logger';
import { UploadResult } from '../interfaces/ScraperTypes';

export class GoogleDriveUploader {
    private drive: drive_v3.Drive;
    private rootFolderId: string;
    private uploadStats: UploadResult;
    private logger: Logger;
    
    /**
     * Constructor for GoogleDriveUploader
     * @param credentialsPath Path to the service account JSON file
     * @param rootFolderId Root folder ID in Google Drive
     */
    constructor(credentialsPath: string, rootFolderId: string) {
        if (!fs.existsSync(credentialsPath)) {
            throw new Error(`Google Drive credentials file not found at: ${credentialsPath}`);
        }
        
        this.logger = Logger.getInstance();
        this.rootFolderId = rootFolderId;
        this.uploadStats = { successful: 0, failed: 0, skipped: 0, total: 0 };
        
        try {
            // Initialize the Google Drive API client with service account credentials
            const auth = new google.auth.GoogleAuth({
                keyFile: credentialsPath,
                scopes: ['https://www.googleapis.com/auth/drive']
            });
            
            this.drive = google.drive({ version: 'v3', auth });
            this.logger.info('Google Drive API initialized successfully');
        } catch (error) {
            this.logger.error('Failed to initialize Google Drive API', error as Error);
            throw new Error(`Failed to initialize Google Drive: ${(error as Error).message}`);
        }
    }
    
    /**
     * Debug method to test Google Drive folder access
     * @returns Promise resolving when tests are complete
     */
    public async debugFolderAccess(): Promise<void> {
        try {
            // Display service account email
            const about = await this.drive.about.get({
                fields: 'user'
            });
            
            this.logger.info(`Service Account Email: ${about.data.user?.emailAddress}`);
            this.logger.info(`Testing access to root folder ID: ${this.rootFolderId}`);
            
            // Test 1: Check if we can access the root folder directly
            try {
                const folder = await this.drive.files.get({
                    fileId: this.rootFolderId,
                    fields: 'id, name, parents, mimeType'
                });
                
                this.logger.info(`Root folder found: ${folder.data.name} (ID: ${folder.data.id})`);
                if (folder.data.mimeType !== 'application/vnd.google-apps.folder') {
                    this.logger.warn(`WARNING: The ID provided is not a folder! Type: ${folder.data.mimeType}`);
                }
            } catch (error) {
                this.logger.error('Root folder access failed', error as Error);
                this.logger.error('CRITICAL: The root folder ID is invalid or the service account does not have permission');
                
                if ((error as any).code === 404) {
                    this.logger.error('Error 404: Folder not found. Please check if the folder ID is correct.');
                } else if ((error as any).code === 403) {
                    this.logger.error('Error 403: Permission denied. The service account does not have access to this folder.');
                    this.logger.error('Make sure you shared the folder with the service account email and gave it "Editor" permission.');
                }
                
                throw error;
            }
            
            // Test 2: Try to list contents of root folder
            try {
                const contents = await this.drive.files.list({
                    q: `'${this.rootFolderId}' in parents and trashed = false`,
                    fields: 'files(id, name, mimeType)',
                    pageSize: 10
                });
                
                const files = contents.data.files;
                this.logger.info(`Root folder contains ${files?.length || 0} items`);
                
                if (files && files.length > 0) {
                    this.logger.info('First 5 items in the root folder:');
                    files.slice(0, 5).forEach(file => {
                        const type = file.mimeType === 'application/vnd.google-apps.folder' ? 'Folder' : 'File';
                        this.logger.info(`- ${type}: ${file.name}`);
                    });
                }
            } catch (error) {
                this.logger.error('Failed to list folder contents', error as Error);
                throw error;
            }
            
            // Test 3: Try to create a test folder
            try {
                const testFolder = await this.drive.files.create({
                    requestBody: {
                        name: 'TEST_FOLDER_DELETE_ME',
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [this.rootFolderId]
                    },
                    fields: 'id, name'
                });
                
                this.logger.info(`Test folder created successfully: ${testFolder.data.name} (ID: ${testFolder.data.id})`);
                
                // Clean up test folder
                await this.drive.files.delete({ 
                    fileId: testFolder.data.id as string 
                });
                this.logger.info('Test folder deleted successfully');
                
                this.logger.success('All Google Drive access tests passed successfully! ✅');
                this.logger.info('Your Google Drive configuration appears to be correct.');
            } catch (error) {
                this.logger.error('Failed to create test folder', error as Error);
                this.logger.error('This suggests the service account does not have write permissions to the folder');
                throw error;
            }
        } catch (error) {
            this.logger.error('Google Drive debug tests failed', error as Error);
            throw error;
        }
    }
    
    /**
     * Batch upload files to Google Drive
     * @param localPaths Array of local file paths to upload
     * @param username Twitter username for folder structure
     * @returns Upload statistics
     */
    public async batchUpload(localPaths: string[], username: string): Promise<UploadResult> {
        if (localPaths.length === 0) {
            this.logger.info('No files to upload to Google Drive');
            return { successful: 0, failed: 0, skipped: 0, total: 0 };
        }
        
        // Initialize stats with correct total
        this.uploadStats = { 
            successful: 0, 
            failed: 0, 
            skipped: 0, 
            total: localPaths.length
        };
        
        try {
            // Create or find the folder structure
            const destinationFolderId = await this.ensureFolderStructure(username);
            this.logger.info(`Uploading ${localPaths.length} files to Google Drive folder for ${username}`);
            
            // Process each file
            for (const localPath of localPaths) {
                const fileName = path.basename(localPath);
                try {
                    // Check if the file already exists
                    const isDuplicate = await this.checkDuplicateExists(fileName, destinationFolderId);
                    
                    if (isDuplicate) {
                        this.uploadStats.skipped++;
                        this.logger.info(`Skipped duplicate file: ${fileName}`);
                    } else {
                        // Upload the file
                        const success = await this.uploadSingleFile(localPath, fileName, destinationFolderId);
                        
                        if (success) {
                            this.uploadStats.successful++;
                            // Log progress periodically
                            if (this.uploadStats.successful % 10 === 0 || 
                                this.uploadStats.successful + this.uploadStats.skipped + this.uploadStats.failed === this.uploadStats.total) {
                                this.logger.info(`Uploaded ${this.uploadStats.successful}/${this.uploadStats.total} files to Google Drive`);
                            }
                        } else {
                            this.uploadStats.failed++;
                            this.logger.error(`Failed to upload: ${fileName}`);
                        }
                    }
                } catch (fileError) {
                    this.uploadStats.failed++;
                    this.logger.error(`Error processing ${fileName}`, fileError as Error);
                }
            }
            
            this.logger.success(
                `Google Drive upload completed: ${this.uploadStats.successful} successful, ` +
                `${this.uploadStats.skipped} skipped, ${this.uploadStats.failed} failed`
            );
            
            // Verify totals make sense before returning
            const calculatedTotal = this.uploadStats.successful + this.uploadStats.failed + this.uploadStats.skipped;
            if (calculatedTotal !== this.uploadStats.total) {
                this.logger.warn(`Upload statistics mismatch: calculated ${calculatedTotal}, expected ${this.uploadStats.total}`);
                // Fix the total to match reality
                this.uploadStats.total = calculatedTotal;
            }
            
            return { ...this.uploadStats };
        } catch (error) {
            this.logger.error('Batch upload failed', error as Error);
            // Return current stats even if main process fails
            return { ...this.uploadStats };
        }
    }
    
    /**
     * Ensure the folder structure exists: /TwitterScraper/username/YYYY-MM-DD/
     * @param username Twitter username
     * @returns ID of the destination folder
     */
    private async ensureFolderStructure(username: string): Promise<string> {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        
        try {
            // Step 1: Ensure TwitterScraper root folder exists
            const rootFolderName = 'TwitterScraper';
            let rootFolder = await this.findOrCreateFolder(rootFolderName, this.rootFolderId);
            
            // Step 2: Ensure username subfolder exists
            let usernameFolder = await this.findOrCreateFolder(username, rootFolder);
            
            // Step 3: Ensure date subfolder exists
            let dateFolder = await this.findOrCreateFolder(today, usernameFolder);
            
            return dateFolder;
        } catch (error) {
            this.logger.error(`Failed to create folder structure for ${username}`, error as Error);
            throw new Error(`Failed to create folder structure: ${(error as Error).message}`);
        }
    }
    
    /**
     * Find folder by name or create it if it doesn't exist
     * @param folderName Name of the folder
     * @param parentFolderId Parent folder ID
     * @returns ID of the folder
     */
    private async findOrCreateFolder(folderName: string, parentFolderId: string): Promise<string> {
        try {
            // First, search for an existing folder
            const response = await this.drive.files.list({
                q: `name = '${folderName}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id, name)',
                spaces: 'drive'
            });
            
            const files = response.data.files;
            
            if (files && files.length > 0) {
                // Folder exists, return its ID
                this.logger.info(`Found existing folder: ${folderName}`);
                return files[0].id!;
            } else {
                // Create folder
                const fileMetadata = {
                    name: folderName,
                    parents: [parentFolderId],
                    mimeType: 'application/vnd.google-apps.folder'
                };
                
                const folder = await this.drive.files.create({
                    fields: 'id',
                    requestBody: fileMetadata
                });
                
                this.logger.info(`Created new folder: ${folderName}`);
                return folder.data.id!;
            }
        } catch (error) {
            this.logger.error(`Failed to find or create folder: ${folderName}`, error as Error);
            throw error;
        }
    }
    
    /**
     * Check if a file with the same name already exists in the folder
     * @param filename Name of the file
     * @param folderId ID of the folder
     * @returns Boolean indicating if file exists
     */
    private async checkDuplicateExists(filename: string, folderId: string): Promise<boolean> {
        try {
            const response = await this.drive.files.list({
                q: `name = '${filename}' and '${folderId}' in parents and trashed = false`,
                fields: 'files(id, name)',
                spaces: 'drive'
            });
            
            const files = response.data.files;
            return !!(files && files.length > 0);
        } catch (error) {
            this.logger.error(`Failed to check for duplicate: ${filename}`, error as Error);
            // If we can't check, assume no duplicate to avoid skipping uploads
            return false;
        }
    }
    
    /**
     * Upload a single file to Google Drive
     * @param localPath Path to local file
     * @param driveFileName Name for the file on Google Drive
     * @param folderId ID of the destination folder
     * @returns Boolean indicating success
     */
    private async uploadSingleFile(localPath: string, driveFileName: string, folderId: string): Promise<boolean> {
        try {
            const fileMetadata = {
                name: driveFileName,
                parents: [folderId]
            };
            
            const media = {
                mimeType: 'image/jpeg',
                body: fs.createReadStream(localPath)
            };
            
            await this.drive.files.create({
                requestBody: fileMetadata,
                media: media,
                fields: 'id'
            });
            
            return true;
        } catch (error) {
            this.logger.error(`Failed to upload ${driveFileName}`, error as Error);
            
            // Retry once
            try {
                this.logger.info(`Retrying upload for ${driveFileName}`);
                
                const fileMetadata = {
                    name: driveFileName,
                    parents: [folderId]
                };
                
                const media = {
                    mimeType: 'image/jpeg',
                    body: fs.createReadStream(localPath)
                };
                
                await this.drive.files.create({
                    requestBody: fileMetadata,
                    media: media,
                    fields: 'id'
                });
                
                return true;
            } catch (retryError) {
                this.logger.error(`Retry failed for ${driveFileName}`, retryError as Error);
                return false;
            }
        }
    }
}
