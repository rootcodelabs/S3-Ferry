import { readFileSync } from 'fs';
import { join } from 'path';

import { load } from 'js-yaml';

/**
 * Load and parse the application.yml configuration file
 * This function reads DSL configuration for upload constraints
 */
export default (): Record<string, any> => {
  const configPath =
    process.env.CONFIG_PATH || join(process.cwd(), 'config', 'application.yml');

  try {
    const fileContents = readFileSync(configPath, 'utf8');
    const config = load(fileContents) as any;

    // Validate required fields
    if (!config.fileTypes || Object.keys(config.fileTypes).length === 0) {
      throw new Error('No file types configured in YAML');
    }

    if (!config.defaults) {
      throw new Error('Default configuration is missing in YAML');
    }

    // Log configuration loaded
    console.log(`✓ Configuration loaded from ${configPath}`);

    // Return configuration for easy access
    return {
      // File type configurations with upload constraints
      fileTypes: config.fileTypes,

      // Global defaults
      defaults: config.defaults,

      // Webhooks configuration
      webhooks: config.webhooks || {},
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`✗ Failed to load configuration: ${errorMsg}`);
    throw new Error(`Configuration loading failed: ${errorMsg}`);
  }
};
