import { getAuthConfig } from "./config";

const bcrypt = require("bcryptjs") as {
  hash: (value: string, saltRounds: number) => Promise<string>;
  compare: (value: string, hash: string) => Promise<boolean>;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, getAuthConfig().bcryptCost);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
