import type { OAuth2Client } from 'google-auth-library';
import type { AppConfig } from '@/shared/config.js';
import type { Database } from '@/platform/db/client.js';
import type { AuthService } from '../auth.service.js';
import type { UserService } from '@/modules/users/index.js';

export type AuthRouterConfig = Pick<AppConfig,
  | 'googleClientId'
  | 'googleClientSecret'
  | 'googleRedirectUri'
  | 'nodeEnv'
  | 'refreshTokenExpiresDays'
  | 'jwtExpiresIn'
  | 'corsOrigin'
  | 'enableOauthFragmentTokens'>

export interface AuthRouterDeps {
  config: AuthRouterConfig
  oauth2Client: OAuth2Client
  authService: AuthService
  userService: UserService
  db: Database
}
