import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

export interface SessionUser {
  id: string;
  email: string | null;
  hederaAccountId: string | null;
  createdAt: string;
}

export async function requireSessionUser(request: NextRequest): Promise<SessionUser> {
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET
  });

  const user = token?.workitUser as SessionUser | undefined;
  if (!user?.id) {
    throw new Error("Unauthorized");
  }

  return user;
}
