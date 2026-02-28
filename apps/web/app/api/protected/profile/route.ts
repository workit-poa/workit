import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

export async function GET(request: NextRequest) {
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET || process.env.AUTH_ACCESS_TOKEN_SECRET
  });
  const user = token?.workitUser as { id: string; email: string | null; hederaAccountId: string | null; createdAt: string } | undefined;
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    user,
    message: "Protected resource access granted"
  });
}
