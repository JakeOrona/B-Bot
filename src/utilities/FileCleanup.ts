/**
 * FileCleanup: Utility for cleaning up old downloaded files
 */

import fs from 'fs';
import path from 'path';
import { Logger } from './Logger';

export class FileCleanup {
    private static logger = Logger.getInstance();
    
    /**
     * Clean up old files from download directory
     * @param downloadPath Root download directory
     * @param daysToKeep Number of days to keep files (default: 3)
     */
    public static async cleanupOldFiles(downloadPath: string, daysToKeep: number = 3): Promise<void> {
        if (!fs.existsSync(downloadPath)) {
            this.logger.warn(`Download path does not exist: ${downloadPath}`);
            return;
        }
        
        try {
            const now = new Date();
            const cutoffDate = new Date(now.setDate(now.getDate() - daysToKeep));
            
            this.logger.info(`Cleaning up files older than ${daysToKeep} days (before ${cutoffDate.toISOString().split('T')[0]})`);
            
            // Get all subdirectories (usernames)
            const userDirs = fs.readdirSync(downloadPath)
                .filter(item => {
                    const fullPath = path.join(downloadPath, item);
                    return fs.statSync(fullPath).isDirectory();
                });
            
            let deletedFilesCount = 0;
            let errorFilesCount = 0;
            
            // Process each user directory
            for (const userDir of userDirs) {
                const userDirPath = path.join(downloadPath, userDir);
                
                // Get all files in the user directory
                const processDirectory = (dirPath: string) => {
                    const items = fs.readdirSync(dirPath);
                    
                    for (const item of items) {
                        const itemPath = path.join(dirPath, item);
                        const stats = fs.statSync(itemPath);
                        
                        if (stats.isDirectory()) {
                            // Recursively process subdirectories
                            processDirectory(itemPath);
                            
                            // Check if directory is empty after processing and remove if it is
                            if (fs.readdirSync(itemPath).length === 0) {
                                fs.rmdirSync(itemPath);
                            }
                        } else if (stats.isFile()) {
                            // Check if the file is older than the cutoff date
                            if (stats.mtime < cutoffDate) {
                                try {
                                    fs.unlinkSync(itemPath);
                                    deletedFilesCount++;
                                } catch (error) {
                                    errorFilesCount++;
                                    this.logger.error(`Failed to delete file: ${itemPath}`, error as Error);
                                }
                            }
                        }
                    }
                };
                
                processDirectory(userDirPath);
            }
            
            this.logger.success(`Cleanup completed: ${deletedFilesCount} files deleted, ${errorFilesCount} errors`);
        } catch (error) {
            this.logger.error('Error during file cleanup', error as Error);
        }
    }
}
