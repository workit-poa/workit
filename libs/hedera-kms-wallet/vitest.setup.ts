import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));

loadDotenv({ path: resolve(packageRoot, ".env.test"), override: false });
loadDotenv({ path: resolve(packageRoot, ".env.test.local"), override: true });
