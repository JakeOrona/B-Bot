/**
 * TwitterAuth: Page object for Twitter/X authentication
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { BasePage } from './BasePage';
import { AuthCredentials, ScraperError, ScraperErrorType } from '../interfaces/ScraperTypes';
import fs from 'fs';
import path from 'path';

export class TwitterAuth extends BasePage {
  private readonly loginUrl: string = 'https://x.com/login';
  private static readonly storageStatePath: string = path.join(process.cwd(), 'config', 'auth-state.json');

  /**
   * Static helper to create a context with persisted auth state if available
   */
  public static async createContextWithAuthState(browser: Browser, logger: any): Promise<BrowserContext> {
    try {
      if (fs.existsSync(TwitterAuth.storageStatePath)) {
        logger.info('Loading saved authentication state...');
        return await browser.newContext({ storageState: TwitterAuth.storageStatePath });
      } else {
        logger.info('No saved authentication state found. Creating new context.');
        return await browser.newContext();
      }
    } catch (err) {
      logger.error(`Failed to load auth state: ${err}. Falling back to new context.`);
      return await browser.newContext();
    }
  }

  /**
   * Save the current context's storage state
   */
  public static async saveAuthState(context: BrowserContext, logger: any): Promise<void> {
    try {
      await context.storageState({ path: TwitterAuth.storageStatePath });
      logger.info('Authentication state saved successfully.');
    } catch (err) {
      logger.error(`Failed to save authentication state: ${err}`);
    }
  }

  /**
   * Constructor for TwitterAuth
   * @param page Playwright Page instance
   * @param context Playwright BrowserContext instance
   * @param browser Playwright Browser instance
   */
  constructor(page: Page, context: BrowserContext, browser: Browser) {
    super(page, context, browser);
  }
  
  // Locators - Authentication related
  private readonly usernameInput = this.page.getByRole('textbox', { name: 'Phone, email, or username' });
  private readonly nextButton = this.page.getByRole('button', { name: 'Next' });
  private readonly passwordInput = this.page.getByRole('textbox', { name: 'password' });
  private readonly loginButton = this.page.getByTestId('LoginForm_Login_Button');
  private readonly passwordField = this.page.locator('input[name="password"]');
  
  // Verification related locators
  private readonly verificationInput = this.page.getByTestId('ocfEnterTextTextInput');
  private readonly verificationNextButton = this.page.getByTestId('ocfEnterTextNextButton');
  private readonly twoFactorInput = this.page.locator('input[data-testid="LoginForm_CodeInput"]');
  
  // Navigation and profile locators
  private readonly homeTabLink = this.page.getByTestId('AppTabBar_Home_Link');
  private readonly accountMenuButton = this.page.getByTestId('SideNav_AccountSwitcher_Button');
  private readonly logoutButton = this.page.getByTestId('AccountSwitcher_Logout_Button');
  private readonly confirmLogoutButton = this.page.getByTestId('confirmationSheetConfirm');
  
  // Additional login verification locators
  private readonly composeButton = this.page.getByTestId('FloatingActionButton');
  private readonly notificationsTabLink = this.page.getByTestId('AppTabBar_Notifications_Link');
  private readonly exploreTabLink = this.page.getByTestId('AppTabBar_Explore_Link');
  private readonly loginForm = this.page.locator('form[data-testid="LoginForm_Login_Button"]').first();
  private readonly signupButton = this.page.getByTestId('signup');
  private readonly userProfileName = this.page.locator('[data-testid="User-Name"]');
  
  /**
   * Login to Twitter with username and password
   * @param credentials Twitter login credentials
   */
  public async login(credentials: AuthCredentials): Promise<void> {
    try {
      // Check if already logged in (validate state)
      if (await this.verifyLoggedIn()) {
        this.logger.success('Already logged in with persisted authentication state.');
        return;
      }
      this.logger.info('Performing full login flow...');
      await this.performFullLogin(credentials);
      // Save storage state after successful login
      await TwitterAuth.saveAuthState(this.context, this.logger);
    } catch (error) {
      this.logger.error('Login failed', error as Error, ScraperErrorType.AUTHENTICATION_ERROR);
      throw new ScraperError(
        `Failed to log in to Twitter: ${(error as Error).message}`,
        ScraperErrorType.AUTHENTICATION_ERROR
      );
    }
  }
  
  /**
   * Perform a full login using the provided credentials
   * @param credentials Twitter login credentials
   */
  private async performFullLogin(credentials: AuthCredentials): Promise<void> {
    // Navigate to login page
    await this.navigateWithRetry(this.loginUrl);
    
    // Wait for the login form
    await this.usernameInput.waitFor({ state: 'visible' });

    // Fill in username
    await this.usernameInput.fill(credentials.username);
    await this.nextButton.click();

    // Check for verification challenge (unusual login activity)
    const hasVerificationChallenge = await this.elementExists('input[data-testid="ocfEnterTextTextInput"]');
    if (hasVerificationChallenge) {
      await this.handleVerificationChallenge(credentials);
    }
    
    // Wait for password field
    await this.waitForSelector('input[name="password"]');
    
    // Fill in password
    await this.passwordInput.fill(credentials.password);
    await this.loginButton.click();

    // Wait for navigation to complete
    await this.page.waitForTimeout(1000); // Wait a bit for the login process to complete
    
    // Handle 2FA if needed
    await this.handle2FA();
    
    // Verify successful login with improved multi-check verification
    if (!(await this.verifyLoggedIn())) {
      // Take screenshot for debugging in case of failure
      const screenshotPath = await this.takeScreenshot('login_failure');
      
      throw new ScraperError(
        `Login failed - unable to verify successful login. Screenshot saved to ${screenshotPath}`,
        ScraperErrorType.AUTHENTICATION_ERROR
      );
    }
    
    this.logger.success('Successfully logged in to Twitter');
  }
  
  /**
   * Handle the verification challenge for unusual login activity
   * @param credentials Twitter login credentials
   */
  private async handleVerificationChallenge(credentials: AuthCredentials): Promise<void> {
    this.logger.info('Detected verification challenge');
    
    // Enter username or email in the verification field
    await this.verificationInput.fill(credentials.username);
    await this.verificationNextButton.click();

    // Wait for the challenge to be processed
    await this.page.waitForLoadState('networkidle');
    
    this.logger.info('Completed verification challenge');
  }
  
  /**
   * Handle 2FA if required
   */
  private async handle2FA(): Promise<void> {
    // Check if 2FA input is present
    const has2FA = await this.twoFactorInput.isVisible();
    
    if (!has2FA) {
      return; // No 2FA required
    }
    
    this.logger.info('2FA verification required');
    
    // Prompt user to enter 2FA code manually
    // In a headless mode, this would be a problem, but we'll watch for code input
    
    // Wait for the 2FA code to be entered (max 60 seconds)
    try {
      await this.page.waitForNavigation({ timeout: 60000 });
      this.logger.info('2FA verification completed');
    } catch (error) {
      throw new ScraperError('2FA verification timed out', ScraperErrorType.AUTHENTICATION_ERROR);
    }
  }
  
  /**
   * Verify if successfully logged in using a multi-step verification strategy
   * @returns Boolean indicating if user is successfully logged in
   */
  private async verifyLoggedIn(): Promise<boolean> {
    try {
      this.logger.info('Verifying login status with multi-step checks...');
      
      // Step 1: Check multiple positive indicators (elements that should be present)
      this.logger.info('Step 1: Checking positive indicators of logged-in state');
      let positiveChecks = 0;
      
      // Create a list of verification promises with timeouts to avoid long waits
      const verificationTimeoutMs = 3000;
      
      // Primary UI elements visible when logged in
      const homeTabVisible = await this.isElementVisible(this.homeTabLink, verificationTimeoutMs);
      if (homeTabVisible) positiveChecks++;
      
      const accountMenuVisible = await this.isElementVisible(this.accountMenuButton, verificationTimeoutMs);
      if (accountMenuVisible) positiveChecks++;
      
      const composeButtonVisible = await this.isElementVisible(this.composeButton, verificationTimeoutMs);
      if (composeButtonVisible) positiveChecks++;
      
      const notificationsTabVisible = await this.isElementVisible(this.notificationsTabLink, verificationTimeoutMs);
      if (notificationsTabVisible) positiveChecks++;
      
      this.logger.info(`Positive indicators found: ${positiveChecks}/4`);
      
      // If we have enough positive indicators, we can be confident user is logged in
      if (positiveChecks >= 2) {
        this.logger.info('Login verified through primary indicators');
        return true;
      }
      
      // Step 2: Verify negative indicators (login elements should be absent)
      this.logger.info('Step 2: Verifying absence of login elements');
      
      const loginFormVisible = await this.isElementVisible(this.loginForm, verificationTimeoutMs);
      const signupButtonVisible = await this.isElementVisible(this.signupButton, verificationTimeoutMs);
      
      if (!loginFormVisible && !signupButtonVisible && positiveChecks > 0) {
        this.logger.info('Login verified through absence of login UI and presence of at least one authenticated element');
        return true;
      }
      
      // Step 3: URL Verification
      this.logger.info('Step 3: Verifying URL patterns');
      const currentUrl = this.page.url();
      
      const isLoginPage = currentUrl.includes('/login') || currentUrl.includes('/signin');
      const isAuthenticatedRoute = currentUrl.includes('/home') || 
                                  currentUrl.includes('/notifications') || 
                                  currentUrl.includes('/messages');
      
      if (isAuthenticatedRoute && !isLoginPage && positiveChecks > 0) {
        this.logger.info('Login verified through URL pattern matching authenticated routes');
        return true;
      }
      
      // Step 4: Final verification attempt - check for personalized content
      if (positiveChecks > 0 || isAuthenticatedRoute) {
        const userProfileVisible = await this.isElementVisible(this.userProfileName, verificationTimeoutMs);
        if (userProfileVisible) {
          this.logger.info('Login verified through presence of user profile elements');
          return true;
        }
      }
      
      this.logger.warn('Login verification failed - insufficient indicators of authenticated state');
      return false;
    } catch (error) {
      this.logger.error('Error during login verification', error as Error);
      return false;
    }
  }
  
  /**
   * Helper method to check if an element is visible with a timeout
   * @param locator The locator to check visibility for
   * @param timeoutMs Maximum time to wait in milliseconds
   * @returns Boolean indicating if the element is visible
   */
  private async isElementVisible(locator: any, timeoutMs: number = 3000): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Remove saved authentication state (logout)
   */
  public static removeAuthState(logger: any): void {
    try {
      if (fs.existsSync(TwitterAuth.storageStatePath)) {
        fs.unlinkSync(TwitterAuth.storageStatePath);
        logger.info('Removed saved authentication state.');
      }
    } catch (error) {
      logger.warn(`Failed to remove auth state file: ${(error as Error).message}`);
    }
  }
  
  /**
   * Logout from Twitter
   */
  public async logout(): Promise<void> {
    try {
      // Click on account menu
      await this.accountMenuButton.click();
      
      // Click on logout option
      await this.logoutButton.click();
      
      // Confirm logout
      await this.confirmLogoutButton.click();

      // Wait for logout to complete
      await this.page.waitForTimeout(1000); // Wait a bit for the logout process to complete

      this.logger.info('Successfully logged out from Twitter');
    } catch (error) {
      this.logger.warn(`Logout failed: ${(error as Error).message}`);
    }
    // Remove saved auth state
    TwitterAuth.removeAuthState(this.logger);
  }
}
