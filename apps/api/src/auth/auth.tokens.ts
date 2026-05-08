import type { Auth0ManagementConfig, AuthConfig } from './auth.config';

/**
 * DI tokens for the auth module. Kept separate from `auth.config.ts`
 * so the config interface can be imported without pulling Nest
 * decorator metadata into purely value-shaped consumers.
 */
export const AUTH_CONFIG = 'AUTH_CONFIG' as const;

export type { AuthConfig, Auth0ManagementConfig };
