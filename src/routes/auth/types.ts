import type { OAuth2Client } from 'google-auth-library';
import type { AppConfig } from '@/config.js';
import type { Database } from '@/db/client.js';
import type { AuthService } from '@/services/auth.service.js';
import type { UserService } from '@/services/user.service.js';

export type AuthRouterConfig = Pick<AppConfig,
  | 'googleClientId'
  | 'googleClientSecret'
  | 'googleRedirectUri'
  | 'nodeEnv'
  | 'refreshTokenExpiresDays'
  | 'jwtExpiresIn'
  | 'corsOrigin'>

export interface AuthRouterDeps {
  config: AuthRouterConfig
  oauth2Client: OAuth2Client
  authService: AuthService
  userService: UserService
  db: Database
}
