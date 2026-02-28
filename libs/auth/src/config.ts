export interface AuthConfig {
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenSecret: string;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  bcryptCost: number;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getAuthConfig(): AuthConfig {
  return {
    jwtIssuer: process.env.AUTH_JWT_ISSUER || "workit-auth",
    jwtAudience: process.env.AUTH_JWT_AUDIENCE || "workit-api",
    accessTokenSecret: getRequiredEnv("AUTH_ACCESS_TOKEN_SECRET"),
    accessTokenTtlMinutes: Number(process.env.AUTH_ACCESS_TOKEN_TTL_MINUTES || 15),
    refreshTokenTtlDays: Number(process.env.AUTH_REFRESH_TOKEN_TTL_DAYS || 30),
    bcryptCost: Number(process.env.AUTH_BCRYPT_COST || 12)
  };
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

export function msFromMinutes(minutes: number): number {
  return minutes * 60 * 1000;
}

export function msFromDays(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

