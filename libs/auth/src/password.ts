import bcrypt from "bcryptjs";
import { getAuthConfig } from "./config";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, getAuthConfig().bcryptCost);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

