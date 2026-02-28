import { createSessionPayload } from "@workit/auth";
import { formatWalletLabel } from "@workit/common";

const demo = createSessionPayload("user_123");
const label = formatWalletLabel("0.0.12345");

console.log("Frontend booted", { demo, label });

