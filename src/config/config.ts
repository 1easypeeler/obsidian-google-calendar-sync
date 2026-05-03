export interface GoogleConfig {
    clientId: string;
    clientSecret?: string; // Make clientSecret optional since we're not using it directly anymore
}

// Load environment variables from .env file
import * as dotenv from 'dotenv';
try {
    dotenv.config();
} catch (e) {
    console.log('Dotenv not available, skipping .env loading (this is normal on mobile)');
}

// Environment variables to use in production
const GOOGLE_CLIENT_ID = process.env?.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env?.GOOGLE_CLIENT_SECRET;

// Load and validate credentials
export function loadGoogleCredentials(): GoogleConfig {
    // For development, use environment variables (allows for testing with different credentials)
    if (GOOGLE_CLIENT_ID) {
        return {
            clientId: GOOGLE_CLIENT_ID,
            // Include clientSecret only if available and needed for development/testing
            ...(GOOGLE_CLIENT_SECRET ? { clientSecret: GOOGLE_CLIENT_SECRET } : {})
        };
    }

    // No built-in credentials — users must supply their own via settings.
    return {
        clientId: ''
    };
}