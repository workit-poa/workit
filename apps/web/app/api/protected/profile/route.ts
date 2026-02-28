import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserFromBearer } from "@workit/auth";

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUserFromBearer(request.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    user,
    message: "Protected resource access granted"
  });
}

