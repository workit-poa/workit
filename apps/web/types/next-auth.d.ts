import type { DefaultSession } from "next-auth";
import type { JWT } from "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      email: string | null;
      hederaAccountId: string | null;
      createdAt: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    workitUser?: {
      id: string;
      email: string | null;
      hederaAccountId: string | null;
      createdAt: string;
    };
  }
}
