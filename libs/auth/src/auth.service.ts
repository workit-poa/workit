import { SessionPayload } from "@workit/common";

export function createSessionPayload(userId: string): SessionPayload {
  return {
    userId,
    issuedAt: new Date().toISOString()
  };
}

