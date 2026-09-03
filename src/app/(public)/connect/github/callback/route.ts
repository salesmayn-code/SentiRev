import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET(request: Request): NextResponse {
  const callbackUrl = new URL(request.url);
  callbackUrl.pathname = "/api/github/install/callback";
  return NextResponse.redirect(callbackUrl);
}
