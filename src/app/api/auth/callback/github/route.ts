import { GET as handleGitHubOAuthCallback } from "@/app/api/auth/github/callback/route";

export const runtime = "nodejs";
export const GET = handleGitHubOAuthCallback;
