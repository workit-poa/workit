import { NextResponse } from "next/server";
import { createSessionPayload } from "@workit/auth";

interface SessionRouteParams {
  params: Promise<{
    userId: string;
  }>;
}

export async function GET(_request: Request, { params }: SessionRouteParams) {
  const { userId } = await params;
  const session = createSessionPayload(userId);
  return NextResponse.json(session);
}

